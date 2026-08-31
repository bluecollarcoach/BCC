/*
 * bcc-api.js — BCC Connect cloud sync layer.
 *
 * Transparent localStorage <-> Cosmos DB sync:
 *   - On load: hits /.auth/me. If signed in, pulls all bcc-* docs from /api/data
 *     and writes them into localStorage. Existing pages keep using localStorage
 *     and don't know cloud-sync is happening.
 *   - Hooks Storage.prototype.setItem so every write to a bcc-* key is also
 *     debounced and pushed to /api/data.
 *   - Anonymous users: bccStorage falls through to plain localStorage only. App
 *     still works for offline / demo, but nothing is synced to the cloud.
 *
 * Injects:
 *   - A sign-in / sign-out / current-user chip into the page's <header.topbar>.
 *   - window.bccUser            — the SWA client principal (or null).
 *   - window.bccSignIn() / bccSignOut() / bccSyncNow()
 *   - 'bcc-auth-ready' window event fires when bootstrap finishes (synced or anon).
 *
 * Drop into any page with <script src="bcc-api.js"></script> BEFORE the page's
 * inline <script> block so it gets a chance to mirror cloud -> localStorage
 * before page code reads from localStorage.
 */
(function () {
  if (window.__pcApiLoaded) return;
  window.__pcApiLoaded = true;

  /* ---------- Early resource hints ----------
   * Inject preconnect / preload hints into <head> as soon as this script
   * runs. They tell the browser to start TLS handshakes and resource
   * downloads in parallel with the rest of HTML parsing, which trims
   * 100-300 ms off page-load on cold-cache visits. Idempotent (the dedupe
   * check skips re-adding on subsequent invocations) and runs only if
   * <head> exists.
   */
  (function injectResourceHints() {
    if (!document.head) return;
    function add(rel, href, attrs) {
      if (document.head.querySelector('link[rel="' + rel + '"][href="' + href + '"]')) return;
      var link = document.createElement('link');
      link.rel = rel; link.href = href;
      if (attrs) Object.keys(attrs).forEach(function (k) { link.setAttribute(k, attrs[k]); });
      document.head.appendChild(link);
    }
    function meta(name, content, useProperty) {
      var attr = useProperty ? 'property' : 'name';
      if (document.head.querySelector('meta[' + attr + '="' + name + '"]')) return;
      var m = document.createElement('meta');
      m.setAttribute(attr, name); m.setAttribute('content', content);
      document.head.appendChild(m);
    }
    // Microsoft auth endpoint — we'll need it the moment the user clicks
    // sign-in. Warming the TCP/TLS handshake means the sign-in click feels
    // snappier when it happens.
    add('preconnect', 'https://login.microsoftonline.com', { crossorigin: '' });
    // Logo shows up in every page's topbar and the home page hero.
    add('preload', '/bcc-logo.png', { as: 'image', fetchpriority: 'high' });
    // Brand fonts: Inter for body, Source Serif 4 for the wordmark + page
    // headings. (The fonts come from bcc-brand.css's @import; this just
    // warms the connection.)
    add('preconnect', 'https://fonts.googleapis.com');
    add('preconnect', 'https://fonts.gstatic.com', { crossorigin: '' });
    // Canonical brand stylesheet (single source of truth — design tokens +
    // components). Injected ahead of any page-specific styles so per-page
    // CSS can override locally if needed. The .bcc body class isn't
    // required for the :root tokens to apply; component classes (.btn,
    // .card, .tag, etc.) only activate inside a .bcc wrapper.
    add('stylesheet', '/bcc-brand.css');

    // ---- PWA installability ----
    // Web App Manifest — lets browsers offer "Add to Home Screen" on every
    // page (each tab counts toward the install heuristics). The manifest
    // itself is anonymous-accessible so it can be fetched pre-auth.
    add('manifest', '/manifest.json');
    // iOS Safari ignores most of the manifest. These tags get the home-
    // screen icon + fullscreen behaviour on iPhone / iPad.
    add('apple-touch-icon', '/bcc-logo-large.png');
    meta('apple-mobile-web-app-capable',         'yes');
    meta('apple-mobile-web-app-status-bar-style','black-translucent');
    meta('apple-mobile-web-app-title',           'BCC');
    meta('mobile-web-app-capable',               'yes');
    // theme-color picked up by Android Chrome (toolbar tint) + iOS PWA
    // (status bar). Most pages already set this in their own <meta>; this
    // is a fallback so pages that forgot still get the right tint.
    meta('theme-color', '#2b2b2b');
  })();

  var API_BASE = '/api';
  var KEY_PREFIX = 'bcc-';
  var PUSH_DEBOUNCE_MS = 1200;

  /* ---------- Top-of-page progress bar ----------
   * A thin red bar that animates from 0->90% while bcc-api.js fetches
   * /.auth/me, /api/data, /api/users, then snaps to 100% and fades.
   * Lets the user know something's loading instead of staring at a
   * blank topbar. ~3 KB of inline CSS+DOM, no dependencies.
   */
  function startProgress() {
    if (document.getElementById('bcc-progress')) return;
    var html = document.documentElement;
    // Respect prefers-reduced-motion: snap to 100% instead of animating.
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var style = document.createElement('style');
    style.setAttribute('data-bcc-progress', '1');
    style.textContent =
      '#bcc-progress{position:fixed;top:0;left:0;height:3px;background:#a8884a;' +
      'width:0;z-index:9999;transition:width 220ms ease-out, opacity 240ms ease-out;' +
      'box-shadow:0 0 8px rgba(168,136,74,0.55);pointer-events:none;}' +
      '#bcc-progress.done{opacity:0;}';
    document.head && document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.id = 'bcc-progress';
    (document.body || html).appendChild(bar);

    // Trickle to 90% so the bar feels alive while we wait on network.
    var pct = 0;
    function tick() {
      if (!bar.parentNode || pct >= 90) return;
      pct = Math.min(90, pct + (reduce ? 30 : (Math.random() * 8 + 2)));
      bar.style.width = pct + '%';
      if (pct < 90) setTimeout(tick, reduce ? 0 : 180);
    }
    setTimeout(tick, 30);
  }
  function finishProgress() {
    var bar = document.getElementById('bcc-progress');
    if (!bar) return;
    bar.style.width = '100%';
    bar.classList.add('done');
    setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 300);
  }

  var signedIn = false;
  /* Distinct from `signedIn === false`. FALSE means /.auth/me answered and said nobody is
     signed in; TRUE means it never answered at all (offline boot, DNS, a 5xx at the edge) and
     we do not know. The two must not be treated alike: an unknown answer that is silently
     read as "anonymous" throws away every write the user makes for the life of the tab. While
     it is set, writes are captured exactly as they are for a signed-in user (see the setItem
     hook) — _flushOnce refuses to send anything until signedIn is true, so a queue built
     under an unknown verdict is held, not pushed, and the pending entries double as the
     guard that stops the eventual boot pull from landing on top of them. */
  var _authUnknown = false;
  var user = null;
  var pending = new Map();
  var pushTimer = null;
  var _origSetItem = Storage.prototype.setItem;
  var _origRemoveItem = Storage.prototype.removeItem;

  /* ---------- durable outbox ----------
     `pending` is an in-memory Map, so every queued write died with the page. Two real
     failures came out of that:
       - Reload or close the tab while offline (or mid-retry) and the queued write was
         gone, while the toast had promised "Saved locally — will sync when reconnected".
         The value still sat in localStorage, so nothing looked wrong until a later full
         pull returned the server's older copy and quietly reverted it.
       - A write made BEFORE /.auth/me resolves was never queued at all: the hooks are
         gated on `signedIn`, and pages are interactive during that window. The bootstrap
         pull then overwrote it. Nothing was logged and no sync error fired.
     So mirror the queue to localStorage and rehydrate it at bootstrap.

     Deliberately NOT a bcc-* key: the hooks' own test is key.indexOf('bcc-') === 0, so a
     non-bcc- name can never be queued, pushed or pruned by this layer. Same reasoning as
     myday.html's 'myday-last-upn'.

     Entries are stamped with the upn that wrote them. Anything written while signed IN is
     safe to replay — it was made against freshly pulled data. Anything written BEFORE auth
     settled is derived from the previous session's snapshot, so replaying it against a
     shared document could silently overwrite a colleague's newer change; those are limited
     to families only their owner ever writes. */
  /* Keys currently being PUT, plus a short grace period after the request settles.
     flush() clears `pending` BEFORE the network round trip, so `pending.has(key)` — the
     only guard the pull sites had — was false for the whole duration of the request. A
     delta poll landing in that window (they run every 8s) applied the server's OLD copy
     straight over the value the user had just saved, and the page repainted it. The
     grace period matters too: a poll GET whose read happened before the upsert can still
     be PROCESSED after the PUT resolves. Map of key -> hold-until timestamp. */
  var inFlight = new Map();
  /* Keys this tab took from the SHARED outbox (localStorage) rather than writing itself.
     `pending` is a per-tab Map, so rehydrating snapshots the shared queue into tab 2 while
     tab 1 still owns those same writes: tab 1 pushes k=v3 and drops it, tab 2 later flushes
     the v2 it snapshotted at boot, and the client's live value silently reverts. For these
     keys — and ONLY these, since a key this tab typed itself is authoritative even when the
     outbox refused it (OUTBOX_MAX) — the shared outbox is the source of truth at flush time.
     A local write to the same key supersedes the snapshot and clears the mark. */
  var _rehydrated = new Set();
  function heldInFlight(key) {
    var until = inFlight.get(key);
    if (until === undefined) return false;
    if (until !== 0 && until < Date.now()) { inFlight.delete(key); return false; }
    return true;
  }

  var OUTBOX_KEY = 'bccOutboxV1';
  var OUTBOX_MAX = 300;
  /* Families whose docs only their owner writes, so an unauthenticated replay cannot
     clobber anyone else. Anything not listed here is dropped rather than guessed at. */
  var OFFLINE_OWNED_PREFIXES = ['bcc-daily-log-', 'bcc-mytasks-', 'bcc-timeentry-', 'bcc-fieldform-'];
  /* The outbox is read AND rewritten on every synced localStorage write, so a bulk import
     re-parsed and re-serialised the entire queue once per document — quadratic, and enough
     to lock the tab up for seconds. Memoize the PARSED object; the write stays synchronous.
     Deliberately not a debounced/deferred write: durability is the only reason this file
     exists, and pagehide is not guaranteed on a crash, an OOM kill or a mobile background
     termination, which are exactly the cases the outbox is here to survive. */
  var _outboxCache = null, _outboxRaw = null;
  function outboxRead() {
    // Verify the memo against what is ACTUALLY in localStorage with a cheap string compare,
    // rather than trusting an invalidation event. The 'storage' event does not fire in the
    // tab that made the change, nor for a page restored from the bfcache — so a tab restored
    // after another tab had queued work held a stale parse and its next write wiped that
    // work. A getItem + === is far cheaper than the JSON.parse this memo exists to avoid.
    var raw = null;
    try { raw = localStorage.getItem(OUTBOX_KEY); } catch (e) {}
    if (_outboxCache && raw === _outboxRaw) return _outboxCache;
    var o;
    try { o = JSON.parse(raw || 'null'); } catch (e) { o = null; }
    _outboxCache = (o && typeof o === 'object' && o.items) ? o : { upn: '', items: {} };
    _outboxRaw = raw;
    return _outboxCache;
  }
  function outboxWrite(o) {
    _outboxCache = o;   // every caller must share one instance, or drop() and rehydrate() disagree
    var str = null;
    try { str = JSON.stringify(o); } catch (e) { str = null; }
    try {
      _origSetItem.call(localStorage, OUTBOX_KEY, str);
      _outboxRaw = str;                 // only once the write actually landed
    } catch (e) {
      // Quota. The in-memory queue still carries it for this page's life, but storage and
      // memory now disagree — forget the raw marker so the next read re-syncs from storage.
      _outboxRaw = null;
    }
  }
  // Another TAB owns the same outbox. Without this the cache would go stale the moment a
  // second tab wrote, and this tab's next write would clobber the other's queued items
  // wholesale — the read-modify-write at least merged them before.
  window.addEventListener('storage', function (e) {
    if (!e || e.key === OUTBOX_KEY || e.key === null) { _outboxCache = null; _outboxRaw = null; }
  });
  function outboxPut(key, value, trusted) {
    var o = outboxRead();
    var who = String((user && user.userDetails) || '').toLowerCase();
    // A different person signed in on this device: start their outbox clean rather than
    // inheriting writes that are not theirs to replay.
    // Rebind the cache too, or the previous person's entries survive in memory into the new
    // session — the exact leak this branch exists to prevent. Their queue is PARKED rather
    // than discarded, so it comes back if they sign in on this device again.
    if (o.upn && who && o.upn !== who) {
      outboxPark(o.upn, o.items);
      o = { upn: who, items: {} }; _outboxCache = o;
      outboxWrite(o);
    }
    if (who) o.upn = who;
    if (!o.items[key] && Object.keys(o.items).length >= OUTBOX_MAX) return; // bounded — NOT recorded below, so it is still sent
    /* qt = when this was queued. The PARKED store has always been age-checked; the LIVE
       queue was not, so a whole-document key (bcc-chat-messages-v1, bcc-schedule-v1) queued
       on a laptop that then stayed shut for a week was replayed verbatim at the next
       sign-in and PUT as a whole-document replace, wiping every change the firm had made in
       between - and outboxPendingAnyTab then blocked the bootstrap pull from repairing it.
       Re-queues after a failed push deliberately KEEP the original stamp: the write is as
       old as when the user made it, not as old as the last retry. */
    var prevQt = o.items[key] && o.items[key].qt;
    // No `rf` carried over: this is a NEW write of that key, not the one the server refused,
    // and it deserves its own attempt.
    o.items[key] = { v: value, t: !!trusted, qt: (typeof prevQt === 'number' && prevQt > 0) ? prevQt : Date.now() };
    /* This key IS in the shared outbox now. If a later flush finds it gone, another tab
       settled it — which is the one case where re-sending this tab's older copy would undo a
       newer value. Distinguished here from the bounded return above, where the entry never
       made it in and therefore must still be sent. */
    _inOutbox.add(key);
    outboxWrite(o);
  }
  /* `sentValues` is OPT-IN: pass a { key: value } map and a key is dropped only while the
     outbox still holds the value this flush actually transmitted. Without it every listed key
     is dropped unconditionally, which is what the rehydrate callers want (they are moving
     entries, not retiring them).
     The value check has to have an escape hatch. An entry that survives a drop keeps the key
     pinned against every pull (outboxPendingAnyTab), so a benign mismatch — a re-serialised
     copy, a value another tab rewrote identically — would freeze that document forever. An
     entry queued no later than the one we sent is therefore dropped anyway: it cannot be the
     newer write this check exists to protect. */
  function outboxDrop(keys, sentValues) {
    if (!keys || !keys.length) return;
    var o = outboxRead(); var changed = false;
    keys.forEach(function (k) {
      var cur = o.items[k];
      if (cur === undefined) return;
      if (sentValues && Object.prototype.hasOwnProperty.call(sentValues, k)) {
        /* Differs = another tab queued something else under this key while we were sending,
           so it is not ours to retire. There is no benign mismatch to make room for: the
           outbox holds the exact string setItem was handed and sentValues holds the exact
           string that went over the wire, both from the same call. The qt-based escape hatch
           this replaces could never NOT fire — outboxPut preserves the original stamp on a
           rewrite (it means "when the user made this write", which the seven-day retirement
           depends on), so the queued entry always looked exactly as old as the one sent, and
           the check it guarded never protected anything.
           Nothing is stranded by leaving it: the tab that queued it holds it in `pending` and
           will flush it, and if that tab is gone outboxRehydrate replays it at the next
           sign-in. */
        if (cur.v !== sentValues[k]) return;
      }
      delete o.items[k]; changed = true;
      /* This tab is retiring the entry itself, so its later absence is NOT another tab
         settling it — clear the marker or the reconcile would drop a re-queue of the same key
         as though somebody else had already written it. */
      try { _inOutbox.delete(k); } catch (e) {}
    });
    if (changed) outboxWrite(o);
  }
  /* PARKING, not deleting. An outbox entry rejected because it belongs to a DIFFERENT user
     is not garbage — it is that person's unsent work, and they may well sign back in on this
     same shared device. Deleting it lost the write permanently, and the bootstrap purge had
     usually already removed the local copy, so it was the last one in existence. Park it by
     owner instead and hand it back when they return.
     Key is deliberately NOT 'bcc-' prefixed: the setItem hook syncs anything that is, which
     would push one user's parked queue into the shared tenant store. */
  var PARKED_KEY = 'bccOutboxParkedV1';
  var PARK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // see the age check in outboxRehydrate
  function parkedRead() {
    try { var o = JSON.parse(localStorage.getItem(PARKED_KEY) || 'null'); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function parkedWrite(o) { try { _origSetItem.call(localStorage, PARKED_KEY, JSON.stringify(o)); } catch (e) {} }
  function outboxPark(upn, items, preserveStamp) {
    var ks = items ? Object.keys(items) : [];
    if (!ks.length) return;
    var all = parkedRead();
    var who = String(upn || '').toLowerCase() || '_unknown';
    var b = all[who] || (all[who] = {});
    // Stamp WHEN it was parked. A parked value has no freshness guarantee of its own, and
    // replaying a weeks-old one on the owner's return would revert everything that happened
    // in between. `pk` is what makes the age check on the way out possible.
    /* preserveStamp KEEPS an entry's original pk. Re-stamping on every re-park would make a
       stale entry immortal — its clock would reset each time the owner signed in, and a
       month-old value would eventually be replayed over live data. That is worse than the
       loss this age check exists to prevent, so entries put BACK because they were refused
       must never be re-dated. */
    var pnow = Date.now();
    ks.forEach(function (k) {
      var it = items[k];
      /* An existing stamp is ALWAYS preserved — a genuinely new write from outboxPut has no
         `pk` and still gets `pnow`, so the flag is no longer what decides it.
         `qt` counts as an existing stamp. A LIVE outbox entry is stamped with qt, never pk,
         so every call site that hands one straight to this function was silently re-dating
         somebody's queued work to now — which let a genuinely old write escape the 7-day
         retirement and be replayed over everything changed since. One call site was fixed
         individually; normalising HERE means none of the others (or any future one) can get
         it wrong. */
      var pk = (typeof it.pk === 'number' && it.pk > 0) ? it.pk
             : ((typeof it.qt === 'number' && it.qt > 0) ? it.qt : pnow);
      b[k] = { v: it.v, t: it.t, pk: pk };
    });
    var have = Object.keys(b);                       // same bound as the outbox itself
    if (have.length > OUTBOX_MAX) have.slice(0, have.length - OUTBOX_MAX).forEach(function (k) { delete b[k]; });
    parkedWrite(all);
  }
  function outboxUnpark(upn) {
    var who = String(upn || '').toLowerCase();
    if (!who) return {};
    /* Buckets an earlier build may have filed this person's work under. keyOwner used to
       return the SANITISED upn for mytasks/emailsig keys, so real unsent work is sitting in
       buckets named 'lyle-bluecollarcoach-us' on live devices right now. Look under those
       names too and merge, or fixing keyOwner alone would leave that work stranded forever.
       Mirrors the two transforms exactly: sani() in myday.html, emSigKey()'s in
       bookkeeping.html (which does NOT trim edge dashes or truncate). */
    var names = [who];
    var sani = who.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    var sig = who.replace(/[^a-z0-9]+/g, '-') || 'x';
    if (names.indexOf(sani) < 0) names.push(sani);
    if (names.indexOf(sig) < 0) names.push(sig);
    var all = parkedRead(); var out = null, changed = false;
    names.forEach(function (n) {
      var b = all[n];
      if (!b) return;
      out = out || {};
      Object.keys(b).forEach(function (k) {
        // The bucket under the person's REAL upn wins: it is the one the current build writes.
        if (out[k] === undefined || n === who) out[k] = b[k];
      });
      delete all[n]; changed = true;
    });
    if (changed) parkedWrite(all);
    return out || {};
  }
  /* Strip settled keys out of the parked store. Without this a key parked while it was
     still in `pending` became unreachable: flush's settle sweep only ever cleaned the
     OUTBOX, so the parked copy survived the successful push forever and was replayed on the
     owner's next sign-in, reverting whatever had happened since.
     Deliberately NOT called from inside outboxDrop — outboxRehydrate calls outboxDrop
     immediately after outboxPark on the very same keys, so purging there would undo the
     park it was just asked to perform. */
  function outboxUnparkKeys(keys) {
    if (!keys || !keys.length) return;
    /* MY bucket only. Sweeping every bucket meant that when I pushed my own copy of a shared
       key, a colleague's still-unsent parked copy of that same key was deleted too — their
       edit destroyed by my successful save. What settled here is only ever mine. */
    var me = String((user && user.userDetails) || '').toLowerCase() || '_unknown';
    var all = parkedRead(), b = all[me];
    if (!b) return;
    var changed = false;
    keys.forEach(function (k) { if (b[k] !== undefined) { delete b[k]; changed = true; } });
    if (!Object.keys(b).length) { delete all[me]; changed = true; }
    if (changed) parkedWrite(all);
  }
  /* Is a local write for this key still UNSENT, as seen by ANY tab? `pending` and `inFlight`
     are per-tab in-memory Maps, but localStorage — and the durable outbox in it — are shared
     by every tab. So the "don't let the server's older copy land on an unsent local write"
     guards only ever protected the tab that made the write: a second tab's 8s poll happily
     overwrote it with Cosmos' older copy, and the first tab then pushed that stale value.
     Deliberately the LIVE outbox only, never the parked store — a parked entry can be weeks
     old and must not pin a key forever. */
  /* `rf` is deliberately excluded. A refused entry is kept as the durable copy of the user's
     work (see the settle sweep and bccRetrySync), but the server has already answered on that
     key: it is not a newer write, it must not pin the key against pulls, and it must not
     stand in for an authoritative read. Counting it here froze the document on that device
     until the entry aged out — colleagues' edits never landed, and the stale copy then
     reported as "primed" with no server read behind it (house rule 3). */
  /* Keys this tab successfully placed in the SHARED outbox. Not the same as `_rehydrated`
     (keys taken FROM it), and not the same as `pending` (which includes keys outboxPut
     refused). See the reconcile in _flushOnce. */
  var _inOutbox = new Set();
  function outboxPendingAnyTab(k) {
    var e = outboxRead().items[k];
    return e !== undefined && !e.rf;
  }
  // Is this key still held anywhere unsent? The bootstrap purge must not remove the last copy.
  function outboxHas(k) {
    if (outboxRead().items[k] !== undefined) return true;
    var all = parkedRead();
    for (var w in all) { if (all[w] && all[w][k] !== undefined) return true; }
    return false;
  }
  /* Replayed at bootstrap, after identity is known and BEFORE the pull is applied — the
     existing `pending.has(...)` guards at the pull and prune sites are what stop the
     server's older copy from landing on top, and they only work if `pending` is seeded
     first. Returns how many writes were recovered. */
  function _bccSaneUpn(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  /* Does this personal key belong to `who`? MODULE SCOPE, one implementation: it started as a
     local of outboxRehydrate, and the moment a second caller needed the same rule (the
     bootstrap flush guard) the choice was to hoist it or to write it twice — and two copies of
     a rule about whose data may be sent is how they drift apart. */
  function bccKeyOwnerOk(k, who) {
    var me = String(who || '').toLowerCase();
    if (!me) return false; // no identity to check against — do not guess
    // These families embed a SANITISED upn (see emSigKey / myTasksKey).
    if (k.indexOf('bcc-mytasks-') === 0) return k === 'bcc-mytasks-' + _bccSaneUpn(me);
    // emSigKey's transform is NOT the same as _bccSaneUpn(): it does not trim edge dashes or
    // truncate, so replicate it exactly rather than approximately.
    if (k.indexOf('bcc-emailsig-') === 0) return k === 'bcc-emailsig-' + (me.replace(/[^a-z0-9]+/g, '-') || 'x');
    // These embed it raw.
    var m = /^(bcc-(?:daily-log|chat-last-read)-)/.exec(k);
    if (m) return k.indexOf(m[1] + me + '-') === 0 || k === m[1] + me;
    return true; // not a personal key shape
  }
  function outboxRehydrate() {
    var o = outboxRead();
    var me = String((user && user.userDetails) || '').toLowerCase();
    /* TWO PASSES, and the order matters. Merging my parked bucket in first and then stamping
       o.upn = me (what this did originally) relabelled the PREVIOUS signer's still-queued
       shared-doc writes as mine, so `mine` was true for them and they were replayed — and
       pushed — under my name. Judge what is already in the outbox against the upn it was
       actually written under FIRST; only then adopt my own parked entries. */
    var keys = Object.keys(o.items || {});
    // A personal doc names its owner IN the key, so that — not the outbox's recorded upn —
    // is the authority on whose it is. This matters for the offline case the outbox exists
    // for: a write made before /.auth/me ever answered has NO recorded upn, so an
    // upn-only check would happily replay one person's offline clock-out under whoever
    // signs in next, where the server refuses it and THEY get the permission toast.
    // 'bcc-mytasks-' carries a sanitised upn; the rest carry it raw.
    var sane = _bccSaneUpn;
    var keyOwnerOk = function (k) { return bccKeyOwnerOk(k, me); };
    /* The owner a personal key NAMES, or '' if it is not a personal key shape. Parking is
       only useful if the entry lands in ITS OWNER's bucket: filing it under the current
       signer meant a colleague's unsent clock-out was parked where only the wrong person
       could ever unpark it, so it was never replayed and never recoverable — the exact loss
       parking was introduced to prevent. Mirrors keyOwnerOk's three key shapes. */
    var keyOwner = function (k) {
      /* mytasks / emailsig embed a SANITISED upn (lyle-bluecollarcoach-us), and the raw one
         cannot be recovered from it. Returning the sanitised form parked the entry under a
         bucket name outboxUnpark(me) — which looks up the RAW upn — could never match, so the
         colleague's unsent work sat there permanently unreachable: the same loss this
         function was added to prevent, just moved. Return '' for those shapes and let the
         caller fall back to the outbox's own recorded upn, which IS the raw upn of the person
         whose queue it was. */
      if (k.indexOf('bcc-mytasks-') === 0 || k.indexOf('bcc-emailsig-') === 0) return '';
      // daily-log carries '-YYYY-MM-DD'; chat-last-read carries '-v1' (see chat.html). The
      // pattern has to strip EITHER, or 'bcc-chat-last-read-lyle@x.com-v1' yielded the owner
      // 'lyle@x.com-v1' — again a bucket nothing can ever match.
      var mm = /^bcc-(?:daily-log|chat-last-read)-(.+?)(?:-\d{4}-\d{2}-\d{2}|-v\d+)?$/.exec(k);
      return mm ? mm[1] : '';
    };
    var kept = 0, drop = [], park = {}, parkOwner = {};
    keys.forEach(function (k) {
      var e = o.items[k];
      var mine = !o.upn || !me || o.upn === me;
      var personal = /^bcc-(daily-log|mytasks|emailsig|chat-last-read)-/.test(k);
      var owned = OFFLINE_OWNED_PREFIXES.some(function (p) { return k.indexOf(p) === 0; });
      // Not mine to replay — but it IS somebody's. Park it rather than destroying it.
      // Park under the key's OWN owner where the key names one; only fall back to the
      // outbox's recorded upn for shapes that name nobody.
      if (personal && !keyOwnerOk(k)) { park[k] = e; parkOwner[k] = keyOwner(k); return; }
      /* ANY key belonging to a different signer, trusted or not. The old rule replayed a
         previous signer's TRUSTED non-personal write (a CRM contact, the schedule) under
         whoever signed in next: at best the document is upserted with their name on it and
         an audit row for a change they never made, at worst the server refuses it, flush
         blacklists the key and the settle sweep drops it — the other person's work destroyed
         while its author is told nothing. Freshness was never the question; whose
         credentials carry the write is. */
      /* Hand outboxPark an explicit `pk`. A live entry carries `qt`, not `pk`, so passing it
         through raw meant outboxPark stamped pk = now and the entry's real queue time was
         lost: a week-old whole-document write came back looking brand new, was replayed on
         the owner's next sign-in and wiped everything the firm had changed since. Mirrors the
         age-park below, which already preserves the stamp. */
      if (!mine) {
        park[k] = { v: e.v, t: e.t, pk: (typeof e.pk === 'number' && e.pk > 0) ? e.pk : e.qt };
        parkOwner[k] = keyOwner(k) || o.upn;
        return;
      }
      /* Too old to replay. A queue entry is meant to live for seconds; one this old is a
         snapshot of a world that has moved on, and these are whole-document writes. Parked
         rather than dropped so it is still recoverable by hand, and parked WITH its original
         stamp so it ages out there instead of looking brand new (which would make it
         immortal — re-parked and re-offered on every single sign-in). */
      /* Either stamp. A live write carries `qt`; an entry re-admitted from the parked store
         carries `pk` (see the unpark below) and nothing else — so reading `qt` alone let a
         round-tripped entry escape this check permanently. Deliberately NOT solved by writing
         `qt` back on re-admission: outboxPut inherits a previous `qt` onto the next write of
         that key, so a genuinely fresh edit would inherit a stamp up to a week old and be
         parked as stale — silent loss of new work, which is the damage this check exists to
         prevent. The age we act on is also the age we preserve. */
      var qAge = (typeof e.qt === 'number' && e.qt > 0) ? e.qt
               : ((typeof e.pk === 'number' && e.pk > 0) ? e.pk : 0);
      if (qAge && (Date.now() - qAge) > PARK_MAX_AGE_MS) {
        park[k] = { v: e.v, t: e.t, pk: qAge }; parkOwner[k] = keyOwner(k) || o.upn || me; return;
      }
      /* Refused by the SERVER last time (see the settle sweep). Kept — it is the only copy
         of that work — but not replayed on its own, or every page load re-sends it into the
         same 403 and re-tells the user about it. bccRetrySync re-queues these deliberately,
         after somebody has changed the permission that refused them. */
      if (e.rf) { return; }
      // Untrusted (pre-auth / offline) writes are replayable only for owner-only families.
      // This one genuinely cannot be attributed to anyone, so it is the only real drop.
      if (!e.t && !owned) { drop.push(k); return; }
      pending.set(k, e.v); _rehydrated.add(k);
      kept++;
    });
    var parkKeys = Object.keys(park);
    if (parkKeys.length) {
      // One bucket per owner, not one bulk park under the signer.
      var buckets = {};
      parkKeys.forEach(function (k) {
        var who = (parkOwner[k] || o.upn || '_unknown').toLowerCase();
        (buckets[who] = buckets[who] || {})[k] = park[k];
      });
      Object.keys(buckets).forEach(function (who) { outboxPark(who, buckets[who]); });
      outboxDrop(parkKeys);          // moved, not lost
    }
    if (drop.length) outboxDrop(drop);

    /* PASS 2 — entries parked earlier under MY upn. Mine by construction, but still
       age-checked: a parked write has no freshness guarantee, and replaying one from weeks
       ago would revert everything that happened in the meantime. A week is long enough to
       cover an offline Friday punch collected the following Monday, and short enough that a
       genuinely stale value never silently overwrites live data. */
    var back = outboxUnpark(me);
    /* '_unknown' is where an entry lands when neither the key nor the outbox names an owner
       (a write queued before /.auth/me resolved, on a device nobody had signed into yet).
       outboxUnpark is only ever called with a upn, so that bucket was never asked for back:
       those writes sat there forever, which is the exact loss parking exists to prevent —
       just filed under a name no one would ever look up. Swept in here alongside my own, and
       every entry still faces the same three tests below: too old to replay, owner-scoped to
       someone else (re-homed to their bucket, not replayed), or superseded by a local write. */
    var orphaned = outboxUnpark('_unknown');
    var fromOrphan = {};
    Object.keys(orphaned).forEach(function (k) { if (back[k] === undefined) { back[k] = orphaned[k]; fromOrphan[k] = true; } });
    var backKeys = Object.keys(back);
    if (backKeys.length) {
      o = outboxRead();                       // the drops above rewrote it
      var now = Date.now(), stale = 0, superseded = 0, keepParked = {}, misfiled = {};
      backKeys.forEach(function (k) {
        var e = back[k];
        /* An entry parked by an EARLIER build has no `pk` — the stamp and this age check
           shipped together, with no migration. Reading a missing stamp as 0 made every such
           entry look like it was parked at the Unix epoch, so the first sign-in after the
           upgrade destroyed exactly the unsent work parking exists to preserve. Treat a
           missing stamp as "parked now" and let it age from here. */
        var pkt = (typeof e.pk === 'number' && e.pk > 0) ? e.pk : now;
        // outboxUnpark already DELETED the whole bucket, so anything refused below has to be
        // put back explicitly or it is destroyed — with its original stamp, never re-dated.
        if (now - pkt > PARK_MAX_AGE_MS) { stale++; keepParked[k] = { v: e.v, t: e.t, pk: pkt }; return; }
        // Refused here too — re-park under the owner the key names, not under me.
        if (/^bcc-(daily-log|mytasks|emailsig|chat-last-read)-/.test(k) && !keyOwnerOk(k)) { misfiled[k] = { v: e.v, t: e.t, pk: pkt }; return; }
        // A queued local write is NEWER than anything parked. Seeding `pending` with the
        // parked copy regardless meant the older value won and the newer edit was reverted.
        if (o.items[k] !== undefined) { superseded++; return; }
        // Carry `pk` through the outbox too. Dropping it meant an ACCEPTED parked entry
        // came back stampless, so if it were ever parked again it would look brand new and
        // the age check could never retire it.
        o.items[k] = { v: e.v, t: e.t, pk: pkt };
        // Marked like every other key taken from the SHARED store rather than typed in this
        // tab. Without the mark, _flushOnce skips the cross-tab reconcile for these: another
        // tab that had already pushed a newer value would be silently reverted by this one.
        pending.set(k, e.v); _rehydrated.add(k);
        kept++;
      });
      o.upn = me;
      outboxWrite(o);
      /* Put back what came OUT of the ownerless bucket, rather than filing it under my name:
         it is not mine, I only swept it in to see whether it could be replayed. Re-parked
         with its original stamp, so it ages exactly as it would have. */
      var keepMine = {}, keepOrphan = {};
      Object.keys(keepParked).forEach(function (k) { (fromOrphan[k] ? keepOrphan : keepMine)[k] = keepParked[k]; });
      if (Object.keys(keepMine).length) outboxPark(me, keepMine, true);         // mine, just too old
      if (Object.keys(keepOrphan).length) outboxPark('_unknown', keepOrphan, true);
      // Someone else's, mis-filed into my bucket by an earlier build — re-home it so its
      // real owner can actually get it back.
      Object.keys(misfiled).forEach(function (k) {
        var who = (keyOwner(k) || '_unknown').toLowerCase();
        var one = {}; one[k] = misfiled[k];
        outboxPark(who, one, true);
      });
      if (stale) console.info('[bcc-api] left ' + stale + ' parked write(s) older than ' + Math.round(PARK_MAX_AGE_MS / 86400000) + ' day(s) parked, not replayed');
      if (superseded) console.info('[bcc-api] dropped ' + superseded + ' parked write(s) superseded by a newer local edit');
    }
    if (kept) schedulePush();
    return kept;
  }

  /* ---------- Service worker registration ----------
   * sw.js pre-caches the four field forms (T&M, Trucking, Hydrant,
   * Inspections) + bcc-api.js + logos so they work offline. Network-
   * first strategy means online users always get fresh code. Skipped
   * silently if the browser doesn't support service workers.
   */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch(function (e) { console.warn('[bcc-api] SW registration failed', e); });
    });
  }

  /* ---------- Online/offline sync trigger ----------
   * When the network comes back, immediately flush any queued writes
   * instead of waiting up to 5 s for the retry timer.
   */
  window.addEventListener('online', function () {
    if (pending.size > 0) {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(flush, 100);
    }
  });

  /* ---------- Re-ask for identity after an unanswered /.auth/me ----------
   * bootstrap() used to ask exactly once. The only 'online' listener was the flush above,
   * and it can never fire for this case: with no principal the setItem hook captured almost
   * nothing, so `pending` is empty and there is nothing to flush. The tab stayed anonymous
   * until someone reloaded it — which nobody does, because the app looks like it is working.
   * Re-running the whole bootstrap is deliberate: identity, the profile/access stamp, the
   * outbox replay and the pull all have to happen together, and every listener it ends with
   * is already guarded against a second run (bootOnce, _ncPollStarted, the #bcc-bell check). */
  var _bootRunning = false;
  var _authRetries = 0;
  function runBootstrap() {
    if (_bootRunning) return Promise.resolve();
    _bootRunning = true;
    return Promise.resolve().then(bootstrap)
      .catch(function (e) { console.warn('[bcc-api] bootstrap failed', e); })
      .then(function () { _bootRunning = false; });
  }
  function retryAuthBootstrap() {
    // Only for the unknown verdict. A genuinely anonymous device answered already, and
    // re-asking on every focus would be a request storm on the sign-in page.
    if (!_authUnknown || _bootRunning || !navigator.onLine) return;
    if (_authRetries >= 25) return;   // a wedged edge shouldn't spin for the life of the tab
    _authRetries++;
    runBootstrap();
  }
  window.addEventListener('online', retryAuthBootstrap);
  window.addEventListener('focus', retryAuthBootstrap);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) retryAuthBootstrap(); });

  /* DEVICE preferences, not firm data. Each is written with the ordinary
     localStorage API, so without this list the hook below would push it to Cosmos as
     a single tenant-wide doc and every other user's delta poll would pull it back —
     one person's choice silently becoming everyone's.
       bcc-last-realm       the client you had open. bookkeeping.html's renderAll()
                            rewrites it on EVERY render (about once a second of active
                            use), so it was being PUT constantly, and every colleague
                            was landed on whichever client someone else last opened.
                            Now that per-client access is enforced, a user without
                            access to that client sees empty panels everywhere — it
                            reads as "my data is gone".
       bcc-push-enabled     whether push notifications are on for THIS browser.
       bcc-sync-since-v1 / bcc-sync-fullpull-at / bcc-field-who
                            per-device sync bookkeeping + identity. Already written via
                            _origSetItem elsewhere; listed so no other write path can
                            reintroduce the push. */
  var _pullIssuedAt = 0;   // when the in-flight full pull was ISSUED — see the prune
  /* Keys THIS DEVICE wrote through the ordinary localStorage API in this session — i.e. the
     app minted or edited them here. The pull and the prime layer both write with
     _origSetItem, so neither shows up: a key in here is ours, not the server's.
     The prune needs it. A record created here BEFORE /.auth/me answered is not in the outbox
     to vouch for itself (only the OFFLINE_OWNED_PREFIXES families are captured that early),
     and its updatedAt is necessarily EARLIER than the full pull that follows on the same page
     load — so an age test alone cannot tell it apart from a record a colleague deleted, and
     deleting it would destroy work that has never been anywhere else. */
  var _localMints = new Set();
  var _pollFailStreak = 0, _pollWasFailing = false, _pollAuthNotified = false;  // live-poll health
  var ACCESS_STAMP_KEY = 'bcc-access-stamp-v1';   // what the SERVER last said this account may see
  // Spelled out rather than interpolated: this list is a literal by design (it is read and
  // checked as one), and ACCESS_STAMP_KEY above must stay in step with the entry here.
  var DEVICE_LOCAL_KEYS = ['bcc-last-realm', 'bcc-push-enabled', 'bcc-sync-since-v1', 'bcc-sync-fullpull-at', 'bcc-field-who', 'bcc-device-last-upn', 'bcc-access-stamp-v1',
    // Dismissing the "turn on notifications" prompt is a per-BROWSER choice. It was
    // being pushed as a tenant-wide doc, so the first person to tap "Not now" turned the
    // prompt off for everyone, permanently — and any tenant copy already in Cosmos would
    // otherwise keep being re-applied over each browser's own value.
    'bcc-push-banner-dismissed', 'bcc-field-who-upn'];

  /* Doc families a FULL pull returns in their ENTIRETY to every signed-in user —
     no per-client gate, no app tier, no owner scoping, and not on the server's
     never-serve list. For THESE ONLY, a key that is in localStorage but absent
     from a full pull genuinely means "someone else deleted it", so the local copy
     is safe to drop (see the reconcile in bootstrap). kb.html / events.html /
     training.html build their lists by enumerating localStorage, so without that
     reconcile a deleted article, event or course stayed on every other browser
     forever and any later write pushed it straight back up.
     Deliberately NOT a generic "anything the server didn't send" sweep:
       - bcc-email- / bcc-cpr-sends- / bcc-financial-period- are never served back
         at all — localStorage is their only home, so absence means nothing;
       - the access-gated families (client-scoped, app-tier, personal) are absent
         merely because THIS user can't see them.
     Pruning on absence would be silent, unrecoverable data loss in both cases.
     Only add a prefix here after confirming /api/data's bulk GET returns it
     unconditionally FOR A USER WHO HAS ACCESS.
     These three are now ALSO app-tier gated server-side (kb / events / training), so
     a user whose tier for that app is 'none' receives none of the family and this
     reconcile clears their local copies. That is the intended outcome — they are not
     supposed to hold that content — and it is recoverable: the prune uses
     _origRemoveItem, so no DELETE is queued and the server copies are untouched; the
     moment their access is restored the next pull brings everything back. Do not
     extend this list to anything whose server copy could be destroyed by pruning. */
  /* bcc-session- belongs here for the same reason bcc-event- does: the family is served
     unconditionally by the bulk pull, so a doc that has DISAPPEARED from the server is a
     doc that was deleted. Without it, a canceled coaching session stayed on every other
     browser forever, and any later edit there re-published it firm-wide. */
  var PRUNABLE_PREFIXES = ['bcc-kb-article-', 'bcc-event-', 'bcc-course-', 'bcc-session-'];


  /* Store a value LOCALLY without queueing a push. For the one shape that legitimately
     needs it: a page that GETs a server document itself (to prove it holds the real copy
     before allowing an autosave) and wants to cache what the server just gave it. Writing
     that through the hooked setItem queues a PUT of the server's own copy straight back —
     wasted on every page open, and a hard 403 for a view-tier bookkeeper, whose refused key
     then poisons the rest of that push batch. Returns false if the write itself failed
     (quota), so the caller can refuse to treat the document as primed. */
  window.bccStoreLocal = function (key, value) {
    /* Never land a server copy on top of an UNSENT local write — the pull path has always
       applied exactly this rule (pending / heldInFlight / outboxPendingAnyTab), and a caller
       priming a document it is about to autosave would otherwise reinstate the server's older
       copy over an edit that has not been flushed yet. Answers true either way: the caller is
       asking "do I hold the authoritative copy?", and an unsent local write IS that copy. */
    try {
      if (pending.has(key) || heldInFlight(key) || outboxPendingAnyTab(key)) return true;
      _origSetItem.call(localStorage, key, value);
      return true;
    } catch (e) { return false; }
  };

  /* ---------- priming a whole-document key ----------
     THE most expensive recurring defect in this app, now found in six families: a page holds
     ONE document (chat history, the rate sheet, a client's postal-mail log, client info, WIP,
     payroll notes), reads it from localStorage, mints a blank when the key is absent, and the
     first edit pushes that blank over everything in Cosmos — for the whole firm, with no
     tombstone and no version to recover from. The key is absent more often than it sounds:
     a new laptop, a private window, a failed boot pull, an evicted PWA cache, or a quota
     failure while storing that very blob.
     One implementation, so the next family to need it cannot get a subtly different one.
       bccPrimeDoc(key, done)  — ask the server what it holds, cache it LOCALLY (never through
                                 the hooked setItem, which would push the server's own copy
                                 straight back and 403 for a view-tier user), then call done().
       bccDocPrimed(key)       — true ONLY when we know what the server has. Gate the write.
     An unsent local write short-circuits to primed: our copy IS the authoritative one, and
     re-fetching would land the server's older copy on top of it. */
  var _primedDocs = {};        // key -> true | 'busy' | 'fail' | 'denied'
  var _primeRetryAt = {};
  window.bccDocPrimed = function (key) { return _primedDocs[key] === true; };
  /* WHY a document is not primed, for callers that show the user a reason. 'fail' is a blip
     worth retrying; 'denied' means the server ANSWERED — you may not read this document — so
     no amount of retrying changes it and "still loading…" is simply untrue. */
  window.bccPrimeState = function (key) { return _primedDocs[key] || null; };
  window.bccPrimeDoc = function (key, done) {
    // Snapshot before the round trip — see the compare in the .then below.
    var beforeRaw = null;
    try { beforeRaw = localStorage.getItem(key); } catch (e) { beforeRaw = null; }
    var fin = function () { try { if (done) done(_primedDocs[key] === true); } catch (e) {} };
    if (!key) { fin(); return; }
    if (_primedDocs[key] === true || _primedDocs[key] === 'busy') { fin(); return; }
    // A write of our own that has not reached the server yet outranks anything it could tell us.
    try { if (pending.has(key) || heldInFlight(key) || outboxPendingAnyTab(key)) { _primedDocs[key] = true; fin(); return; } } catch (e) {}
    // A refusal is not retryable at all: the server has answered, and hammering it every few
    // seconds for the life of the tab changes nothing.
    if (_primedDocs[key] === 'denied') { fin(); return; }
    // A failed attempt is retryable, but not on every keystroke.
    var now = Date.now();
    if (_primedDocs[key] === 'fail' && _primeRetryAt[key] && (now - _primeRetryAt[key]) < 5000) { fin(); return; }
    _primeRetryAt[key] = now;
    _primedDocs[key] = 'busy';
    fetch(API_BASE + '/data/' + encodeURIComponent(key), { credentials: 'include' })
      .then(function (r) {
        if (r.ok) return r.json();
        // Carry the status so the catch can tell a refusal from a blip. 403 only: a 401 means
        // "not signed in yet", which signing in fixes, so that stays retryable.
        var err = new Error('HTTP ' + r.status); err.status = r.status; throw err;
      })
      .then(function (j) {
        var d = j && j.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        // data:null is a real answer — the document genuinely does not exist yet.
        var ok = true;
        /* Landed while we were asking? Then it is at least as new as what we fetched — keep
           it. The key is still PRIMED either way: the point of priming is to know the server
           has spoken, and it has. */
        var nowRaw = null;
        try { nowRaw = localStorage.getItem(key); } catch (e) { nowRaw = null; }
        if (nowRaw !== beforeRaw) { _primedDocs[key] = true; fin(); return; }
        if (d !== null && d !== undefined) ok = window.bccStoreLocal(key, JSON.stringify(d));
        _primedDocs[key] = ok ? true : 'fail';   // a failed STORE must not count as primed
        fin();
      })
      .catch(function (e) { _primedDocs[key] = ((e && e.status) === 403) ? 'denied' : 'fail'; fin(); });
  };

  /* ---------- hooks ---------- */
  Storage.prototype.setItem = function (key, value) {
    _origSetItem.call(this, key, value);
    // Provenance, recorded for EVERY bcc-* write through this hook whatever the auth state —
    // the prune's one honest signal that a record was minted here. (The pull and the prime
    // cache both bypass this hook by design, so they never land in here.)
    if (this === window.localStorage && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0) {
      try { _localMints.add(key); } catch (e) {}
    }
    // Writes made before auth settles used to fall straight through this guard and be
    // lost. Capture the owner-only ones so bootstrap can replay them; outboxRehydrate
    // decides what is safe to keep.
    if (this === window.localStorage && !signedIn && !_authUnknown && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0
        && OFFLINE_OWNED_PREFIXES.some(function (p) { return key.indexOf(p) === 0; })) {
      outboxPut(key, value, false);
    }
    if (this === window.localStorage && (signedIn || _authUnknown) && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0) {
      if (DEVICE_LOCAL_KEYS.indexOf(key) >= 0) return;
      // Financial periods are owned by the server (the QBO sync writes them to
      // Cosmos as flat, access-scoped docs). Don't push them back: it would
      // collide with the server doc AND expose every client's books through the
      // un-scoped /api/data pull. The UI loads them via /integrations/qbo/periods.
      if (key.indexOf('bcc-financial-period-') === 0) return;
      // CPR "sent email" history holds third-party recipient emails + a send timeline.
      // Deliberately device-local: never pushed, so one client's payroll contacts are
      // never stored tenant-wide in the first place.
      if (key.indexOf('bcc-cpr-sends-') === 0) return;
      // Sent-client-email records hold the recipient list, subject and full body
      // (including the sender's personal signature). Same reasoning as bcc-cpr-sends-
      // above. The durable audit trail is the 'client-email-send' audit event, not
      // this record.
      // NOTE (2026-08-08): /api/data DID gain a real per-client access gate, and both
      // prefixes are now covered by it server-side — but that is defense in depth
      // against a hand-crafted request, NOT a reason to start syncing these. Keeping
      // them device-local means the correspondence body and the sender's personal
      // sign-off are never written to shared storage at all, which is a stronger
      // guarantee than an access check on data that IS stored. Do not "enable sync"
      // for these on the grounds that the gate now exists.
      if (key.indexOf('bcc-email-') === 0) return;
      pending.set(key, value); _rehydrated.delete(key); // typed here: ours, not a snapshot
      /* `signedIn`, not a literal true. Under _authUnknown this write cannot be attributed to
         anyone yet, and outboxRehydrate's trusted flag is precisely what decides whether an
         entry may be replayed under whoever signs in NEXT — a shared document written on a
         device booted offline would otherwise be pushed under a colleague's name. Untrusted
         entries are still replayed for the owner-only families, same as before, and the
         in-memory `pending` entry above (which protects it from the pull and is what the
         flush sends once this tab learns who it is) is unaffected either way. */
      outboxPut(key, value, signedIn); // survives a reload or a tab close before the flush lands
      schedulePush();
      // Admin user list / status changed → re-filter bccPeople immediately so
      // every dropdown in the app reflects the new active/hidden/inactive
      // status without a refresh.
      if (key === 'bcc-admin-config-v1' && window.bccPeopleFull) {
        try {
          recomputePcPeople();
          window.dispatchEvent(new Event('bcc-users-ready'));
        } catch (e) {}
      }
    }
  };
  Storage.prototype.removeItem = function (key) {
    _origRemoveItem.call(this, key);
    /* PRE-VERDICT DELETES ARE QUEUED TOO. The setItem hook above already keeps a write made
       before /.auth/me answers; this did not keep the matching DELETE, so a record removed in
       that first second disappeared from the screen — which reads as a confirmed deletion —
       and came straight back on the next pull, because nothing ever told the server. Doing it
       again inside the same window did the same thing again. `_authUnknown` covers the
       in-flight case; this adds the window before even that flag is meaningful. */
    if (this === window.localStorage && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0
        && !signedIn && !_authUnknown && DEVICE_LOCAL_KEYS.indexOf(key) < 0) {
      /* Queued UNTRUSTED, exactly as the pre-auth setItem branch does: it is replayed only for
         the owner-only families the replay is allowed to attribute, and dropped otherwise
         rather than guessed at. */
      try { pending.set(key, null); outboxPut(key, null, false); } catch (e) {}
    }
    if (this === window.localStorage && (signedIn || _authUnknown) && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0) {
      if (DEVICE_LOCAL_KEYS.indexOf(key) >= 0) return; // device preference (see setItem)
      if (key.indexOf('bcc-financial-period-') === 0) return; // server-owned (see setItem)
      if (key.indexOf('bcc-cpr-sends-') === 0) return; // device-local (see setItem)
      if (key.indexOf('bcc-email-') === 0) return;     // device-local (see setItem)
      pending.set(key, null); _rehydrated.delete(key); // ours, not a snapshot
      outboxPut(key, null, signedIn);   // see setItem: an unattributable delete is not trusted
      schedulePush();
    }
  };

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, PUSH_DEBOUNCE_MS);
  }

  // Keys that have already been rejected with 4xx in this session — we stop
  // retrying them so a single permission failure doesn't loop forever
  // hammering the API every 5s.
  var permanentlyFailed = new Set();
  // Remembers the status that blacklisted each key, so a LATER edit to it can say
  // why it isn't being saved instead of disappearing without a word.
  var failedStatus = {};
  var _skipNotifyAt = 0;

  /* flush() is SERIALIZED. It used to be re-entrant: the 5s retry, schedulePush, bccSyncNow,
     bccRetrySync and sign-out can all call it while one is mid-flight, and each call snapshots
     `pending` and clears it. Two overlapping flushes therefore both held snapshots, and when
     the slower one failed it re-queued its STALE value over a newer edit the faster one had
     already consumed and sent — a silent revert of the user's most recent change. With one
     flush at a time the `pending.has()` guards mean "a newer write exists" again, which is
     what they were written to mean. Every caller treats the result as a promise or
     fire-and-forget, and sign-out keeps its own 2.5s cap, so chaining cannot wedge it. */
  var _flushChain = null;
  function flush() {
    _flushChain = (_flushChain || Promise.resolve()).then(_flushOnce, _flushOnce);
    return _flushChain;
  }
  async function _flushOnce() {
    if (!signedIn || pending.size === 0) return;
    var entries = Array.from(pending.entries());
    pending.clear();
    /* Reconcile the snapshot against the shared outbox before anything goes over the wire.
       Gone from the outbox = another tab pushed it successfully; sending our older copy
       would undo that. Different value = another tab queued a newer one; send theirs. */
    /* Two different questions, and the old code only asked one of them.
       For a key this tab REHYDRATED from the shared outbox, that outbox is authoritative:
       gone = another tab pushed it, different = another tab queued something newer.
       For a key this tab QUEUED ITSELF, this tab's value stays authoritative — another tab's
       queued copy must never overwrite what the person in front of this one just typed.
       What was missing is the third case: a key this tab queued itself, successfully wrote to
       the outbox, and that has since VANISHED from it. Vanishing means settled — so re-sending
       this tab's older snapshot (re-queued by a transient push failure) would undo the newer
       value another tab has already saved. `_inOutbox` records which keys actually made it in,
       so that is distinguishable from a key outboxPut refused on quota, which must still go. */
    if (_rehydrated.size || _inOutbox.size) {
      var shared = outboxRead().items || {};
      entries = entries.filter(function (e) {
        var cur = shared[e[0]];
        if (!_rehydrated.has(e[0])) {
          // Ours. Only the vanished-after-being-accepted case changes anything.
          if (cur === undefined && _inOutbox.has(e[0])) { _inOutbox.delete(e[0]); return false; }
          return true;
        }
        if (cur === undefined) { _rehydrated.delete(e[0]); return false; }
        if (cur.v !== e[1]) e[1] = cur.v;
        return true;
      });
      if (!entries.length) return;
    }
    // 0 = "no expiry yet, the request is still open"; a real timestamp is stamped when
    // the flush settles, below.
    entries.forEach(function (e) { inFlight.set(e[0], 0); });

    var puts = [];
    var deletes = [];
    // Keep each key's ORIGINAL raw value so a re-queue after a transient failure
    // restores exactly what was queued, rather than a JSON round-trip of it.
    var rawByKey = {};
    entries.forEach(function (e) {
      if (permanentlyFailed.has(e[0])) {
        // The key was refused earlier this session, so nothing is sent — but the user
        // has just edited it AGAIN and would otherwise get no hint that the change is
        // going nowhere. Re-announce (debounced; one refused key can be touched a lot).
        var nowT = Date.now();
        if (nowT - _skipNotifyAt > 4000) {
          _skipNotifyAt = nowT;
          window.dispatchEvent(new CustomEvent('bcc-sync-error', { detail: { key: e[0], status: failedStatus[e[0]] || 403 } }));
        }
        return;
      }
      if (e[1] === null) deletes.push(e[0]);
      else {
        rawByKey[e[0]] = e[1];
        try { puts.push({ key: e[0], data: JSON.parse(e[1]) }); }
        catch { puts.push({ key: e[0], data: e[1] }); } // non-JSON value, store raw
      }
    });

    if (!puts.length && !deletes.length) {
      // Nothing is actually going over the wire (every entry was already permanently
      // refused), so release the hold immediately — leaving these at 0 would block the
      // pull from ever updating those keys again for the life of the page.
      entries.forEach(function (e) { inFlight.delete(e[0]); });
      /* FLAGGED, NOT DROPPED — the same rule the settle sweep applies, because this is its
         twin and it is the branch a real person reaches: they are told "that was not saved",
         they type it again, and every entry in this flush is a key already refused, so
         nothing goes over the wire and control arrives here. Dropping retired the copy they
         had just re-entered, leaving it only in this tab's memory: gone at the next reload,
         and nothing left for bccRetrySync to resend.
         The `rf` flag is what keeps it from being replayed into the same refusal on every
         page load, and outboxPendingAnyTab now ignores flagged entries, so keeping it costs
         one outbox row and pins nothing. */
      try {
        var _ob0 = outboxRead(), _t0 = false;
        entries.forEach(function (e) { if (_ob0.items[e[0]]) { _ob0.items[e[0]].rf = 1; _t0 = true; } });
        if (_t0) outboxWrite(_ob0);
      } catch (e) {}
      setSyncState('idle');
      return;
    }

    setSyncState('pushing');
    var putStatus = 0;
    var putRefused = false;
    try {
      if (puts.length) {
        const r = await fetch(API_BASE + '/data', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: puts })
        });
        putStatus = r.status;
        if (!r.ok) {
          // A 401/408/429 is TRANSIENT, not a permanent refusal: the session
          // expired, the request timed out, or we're being throttled. Treating
          // those as permanent (as this did) silently threw away the user's
          // edit forever — signing back in would NOT recover it, because the key
          // was already in permanentlyFailed. Re-queue and retry instead, and
          // still surface the 401 so the user knows to sign back in.
          if (r.status === 401 || r.status === 408 || r.status === 429) {
            window.dispatchEvent(new CustomEvent('bcc-sync-error', {
              detail: { key: null, status: r.status, transient: true }
            }));
            throw new Error('PUT failed ' + r.status);
          }
          if (r.status >= 400 && r.status < 500) {
            // The server validates a PUT batch ALL-OR-NOTHING, so a single refused
            // key 4xxs the whole array. Blacklisting every key in the batch
            // therefore discarded unrelated, perfectly legitimate edits — and
            // permanentlyFailed persists for the session, so every later write to
            // those keys was silently dropped too. Re-send each item on its own to
            // find the actual offender(s) and blacklist only those.
            for (var pi = 0; pi < puts.length; pi++) {
              var p = puts[pi];
              var ir = null;
              try {
                ir = await fetch(API_BASE + '/data/' + encodeURIComponent(p.key), {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ data: p.data })
                });
              } catch (netErr) {
                // ...unless the user has already typed something newer (see the catch
                // block at the bottom of flush for why that can happen mid-PUT).
                if (!pending.has(p.key)) pending.set(p.key, rawByKey[p.key]); // network blip — keep it queued
                continue;
              }
              if (ir.ok) continue;                                   // this one was fine
              if (ir.status === 401 || ir.status === 408 || ir.status === 429 || ir.status >= 500) {
                if (!pending.has(p.key)) pending.set(p.key, rawByKey[p.key]); // transient — retry later
                continue;
              }
              permanentlyFailed.add(p.key); failedStatus[p.key] = ir.status; // genuinely refused
              console.warn('[bcc-api] push refused (' + ir.status + '), dropping key:', p.key);
              window.dispatchEvent(new CustomEvent('bcc-sync-error', {
                detail: { key: p.key, status: ir.status }
              }));
            }
            if (pending.size) schedulePush();                        // anything re-queued above
            // Deliberately NOT returning here. The queued DELETEs are a separate
            // per-item request loop below and have nothing to do with a refused
            // PUT. Returning early skipped them silently: the row was already gone
            // locally, so the UI looked right while the server copy survived and
            // reappeared on the next pull.
            putRefused = true;
          } else {
            throw new Error('PUT failed ' + r.status);
          }
        }
        // Audit: one entry per batch flush, listing the keys touched
        if (!putRefused) window.bccAudit && window.bccAudit('data-write', { meta: { keys: puts.map(function (p) { return p.key; }) } });
      }
      for (var i = 0; i < deletes.length; i++) {
        var dkey = deletes[i];
        var dr = await fetch(API_BASE + '/data/' + encodeURIComponent(dkey), { method: 'DELETE' });
        if (!dr.ok) {
          // A 401/408/429 or any 5xx is TRANSIENT — the record is already gone from
          // this browser, so dropping it here left the server copy alive to reappear
          // on the next pull. Re-queue the deletion instead of pretending it worked.
          if (dr.status === 401 || dr.status === 408 || dr.status === 429 || dr.status >= 500) {
            if (!pending.has(dkey)) pending.set(dkey, null); // a newer write to this key wins over re-queuing the delete
            schedulePush();
            window.dispatchEvent(new CustomEvent('bcc-sync-error', { detail: { key: dkey, status: dr.status, transient: true } }));
            continue;
          }
          // A genuine 4xx (e.g. no permission to delete this) is permanent — but it
          // used to be swallowed with no event at all, so the row vanished locally
          // while the server kept it and the user was never told.
          permanentlyFailed.add(dkey); failedStatus[dkey] = dr.status;
          window.dispatchEvent(new CustomEvent('bcc-sync-error', { detail: { key: dkey, status: dr.status } }));
          continue;
        }
        // Only audit an actual success — this used to log 'data-delete' even for a 5xx.
        window.bccAudit && window.bccAudit('data-delete', { key: dkey });
      }
      setSyncState(putRefused ? 'error' : 'idle');
    } catch (err) {
      console.warn('[bcc-api] push failed (transient), re-queuing in 5s:', err);
      // Only re-queue items that aren't permanently failed
      entries.forEach(function (e) {
        if (permanentlyFailed.has(e[0])) return;
        // Never clobber a NEWER local write. flush() clears `pending` up front, so the
        // user can edit the same key again while the PUT is in flight; re-queuing the
        // snapshot on failure then threw that newer edit away silently. This is the same
        // "queued local write wins" invariant the pull and prune sites already assert.
        if (pending.has(e[0])) return;
        pending.set(e[0], e[1]);
      });
      setSyncState('error');
      setTimeout(flush, 5000);
    }
    // Anything no longer in `pending` is settled — it landed, or it was permanently
    // refused (in which case the user has already been told and replaying it forever
    // would just re-tell them). Whatever got re-queued above stays in the outbox so it
    // still survives a reload. This single sweep covers every exit path above.
    /* A key the server REFUSED is not settled. It is not in `pending` (the per-key isolation
       pass blacklists rather than re-queues it), so it used to fall into this sweep and have
       its durable copy dropped as well — the user gets one toast, her edited text stays on
       screen, and the write now exists nowhere but this tab. Reloading, which is exactly what
       someone does after "you don't have permission", loses it for good, and bccRetrySync had
       nothing left to resend. Keep refused keys in the outbox: they cost one entry each and
       they are the only copy. */
    var settledKeys = entries.map(function (e) { return e[0]; })
      .filter(function (k) { return !pending.has(k) && !permanentlyFailed.has(k); });
    /* Flag the refused ones where they sit. Keeping them alive in the queue would have the
       next bootstrap re-send them into the same refusal and re-toast on every page load —
       the "replayed forever" the old drop was avoiding. Flagged, they are skipped by the
       replay and picked up only by bccRetrySync, which is what an admin clicks after
       actually granting the permission. */
    try {
      var _refusedNow = entries.map(function (e) { return e[0]; }).filter(function (k) { return permanentlyFailed.has(k); });
      if (_refusedNow.length) {
        var _ob = outboxRead();
        var _touched = false;
        _refusedNow.forEach(function (k) { if (_ob.items[k]) { _ob.items[k].rf = 1; _touched = true; } });
        if (_touched) outboxWrite(_ob);
      }
    } catch (e) {}
    /* What we actually SENT, after the _rehydrated reconcile above may have swapped in another
       tab's newer value — that reconcile rewrites e[1], so `entries` is the transmitted copy,
       and comparing against `pending` instead would compare with a write that never went. */
    var sentValues = {};
    entries.forEach(function (e) { sentValues[e[0]] = e[1]; });
    outboxDrop(settledKeys, sentValues);
    outboxUnparkKeys(settledKeys);   // a parked copy of a key that has now SHIPPED must go too
    // Hold each key for one more poll interval so a response already in flight, built
    // from a pre-write read, can't land on top of what we just saved.
    var holdUntil = Date.now() + LIVE_POLL_MS + 2000;
    entries.forEach(function (e) { if (inFlight.get(e[0]) === 0) inFlight.set(e[0], holdUntil); });
  }

  // Manually clear the permanent-failure set (admins call this after granting
  // the right role) and re-trigger a flush.
  window.bccRetrySync = function () {
    /* Re-seed from the durable outbox before flushing. Clearing the blacklist alone only
       helped a key that happened to be still in memory — after the reload the person almost
       certainly did, `pending` is empty and this flushed nothing at all while reporting
       success. The outbox is where a refused write now lives (see the settle sweep). */
    var reseeded = 0;
    /* Declared OUT HERE, not inside the try. `var` hoists, so the reads below compiled either
       way — but if outboxRead() itself threw, `want` was still `undefined` when
       Object.keys(want) ran after the catch, and bccRetrySync died on the one control a
       person reaches when their work has already failed to save once. */
    var want = {};
    try {
      var _obAll = outboxRead();
      var ob = _obAll.items || {};
      /* Every key the outbox still holds a REFUSED copy of, plus anything refused in this
         session. permanentlyFailed alone was empty after a reload — which is exactly when
         somebody clicks this — so the recovery path recovered nothing and reported success.
         The outbox is durable and survives the reload; it is the real list. */
      Object.keys(ob).forEach(function (k) { if (ob[k] && ob[k].rf) want[k] = 1; });
      permanentlyFailed.forEach(function (k) { want[k] = 1; });
      Object.keys(want).forEach(function (k) {
        var e = ob[k];
        if (!e) return;
        /* A refused DELETE has v === null, which is a real queued value, not a missing one.
           Requiring a string skipped exactly those — and the flag was stripped anyway, so the
           entry became both un-resendable and un-findable: a deletion the person performed,
           was told did not save, and could never make happen. */
        if (!pending.has(k) && (typeof e.v === 'string' || e.v === null)) { pending.set(k, e.v); reseeded++; }
        /* Clear the flag as it goes back in: it is a live attempt again, and if it is refused
           a second time the settle sweep re-flags it. Leaving it set would make the replay
           skip it at the next reload even though it is queued. */
        delete e.rf;
      });
      /* ALWAYS persisted, not only when something was re-queued. `delete e.rf` mutates the
         cached object either way, so skipping the write left localStorage disagreeing with
         memory — and the flag would come back at the next reload. */
      outboxWrite(_obAll);
    } catch (e) {
      /* The durable half is unreadable. The in-memory half still is: seed whatever this
         session knows was refused rather than giving up entirely. */
      try { permanentlyFailed.forEach(function (k) { want[k] = 1; }); } catch (e2) {}
    }
    permanentlyFailed.clear();
    if (reseeded) console.info('[bcc-api] re-queued ' + reseeded + ' previously refused change(s)');
    // Watched until the outbox actually lets go of them, so the bar cannot vanish in the gap
    // where a re-queued key carries no `rf` flag and has not yet been written.
    _retryWatch = Object.keys(want);
    /* Report what was SAVED, not what was queued. Counting the re-queue meant the banner
       could say "5 changes saved" over five that were refused a second time — which is the
       kind of message that costs more trust than the original failure. */
    var attempted = Object.keys(want);
    return flush().then(finishRetry, finishRetry);
    function finishRetry() {
      /* An entry LEAVES the outbox only when its write has actually settled. Counting
         "no longer flagged rf" instead was wrong in the one case that matters: this function
         strips that flag off every key as it re-queues it, so a transient failure — a mid-day
         401, a 5xx, a dropped connection — left them unflagged AND unsent, and the count read
         as "all saved". The bar then hid itself. */
      var left = {};
      try { left = outboxRead().items || {}; } catch (e) { left = {}; }
      var stillHeld = attempted.filter(function (k) { return left[k] !== undefined; });
      var saved = Math.max(0, attempted.length - stillHeld.length);
      window._bccLastRetryCount = saved;
      refreshRefusedBar();
      return { requeued: reseeded, saved: saved, stillQueued: stillHeld.length, stillRefused: bccRefusedCount() };
    }
  };
  /* How many of the user's changes the server has refused and we are still holding. Read from
     the DURABLE outbox, so it survives a reload — which is when somebody comes back to this. */
  function bccRefusedCount() {
    try {
      var it = outboxRead().items || {};
      return Object.keys(it).filter(function (k) { return it[k] && it[k].rf; }).length;
    } catch (e) { return 0; }
  }
  /* How many keys a retry attempt is still holding, flagged or not. A key re-queued by
     bccRetrySync has had its `rf` cleared, so between the retry and the next refusal it is
     invisible to bccRefusedCount — and that is exactly the window in which the bar must not
     disappear. Set by the retry, cleared when the outbox lets go of them. */
  var _retryWatch = [];
  function retryStillHeld() {
    if (!_retryWatch.length) return 0;
    var left = {};
    try { left = outboxRead().items || {}; } catch (e) { return 0; }
    _retryWatch = _retryWatch.filter(function (k) { return left[k] !== undefined; });
    return _retryWatch.length;
  }
  window.bccRefusedCount = bccRefusedCount;
  /* THE CALLER. A pinned bar, because this has to survive the reload the person almost
     certainly does and be there when an admin finally grants the access that was missing —
     a toast that vanished in eight seconds could never do that job. Same placement machinery
     as the offline bar, so it sits under the topbar rather than over the only navigation. */
  var _refusedBusy = false;
  function refreshRefusedBar() {
    if (!document.body) return;
    var refused = bccRefusedCount();
    var queued = retryStillHeld();
    var n = refused || queued;
    var bar = document.getElementById('bcc-refused-bar');
    if (!n) { if (bar) bar.classList.remove('show'); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bcc-refused-bar';
      bar.className = 'bcc-offline bcc-refused';
      bar.innerHTML = '<span class="bcc-refused-msg"></span> <button type="button" class="bcc-refused-go">Try saving them again</button>';
      (document.body || document.documentElement).appendChild(bar);
      bar.querySelector('.bcc-refused-go').onclick = function () {
        if (_refusedBusy) return;
        _refusedBusy = true;
        var btn = bar.querySelector('.bcc-refused-go');
        btn.disabled = true; btn.textContent = 'Trying…';
        window.bccRetrySync().then(function (r) {
          _refusedBusy = false;
          btn.disabled = false; btn.textContent = 'Try saving them again';
          if (!window.bccNotify) return;
          if (r && r.saved) {
            window.bccNotify(r.saved + ' change' + (r.saved === 1 ? '' : 's') + ' saved.'
              + (r.stillQueued ? ' ' + r.stillQueued + ' still waiting.' : ''), r.stillQueued ? 'warn' : 'success', r.stillQueued ? 9000 : 6000);
          } else if (r && r.stillRefused) {
            window.bccNotify('Still not saved — the server is still refusing those changes. Ask an admin to check your access, then try again. Nothing has been lost.', 'warn', 12000);
          } else {
            /* Nothing landed and nothing was refused: the attempt itself did not get through.
               Telling them it was refused would send them to an admin over a dropped
               connection. */
            window.bccNotify('Couldn’t reach the server just now, so those changes are still waiting. They are safe on this device and will keep retrying.', 'warn', 10000);
          }
        }, function () {
          _refusedBusy = false;
          btn.disabled = false; btn.textContent = 'Try saving them again';
        });
      };
    }
    /* Two different truths. "Refused" is the server saying no; "still queued" is a retry that
       has not landed yet — usually a transient failure that will clear on its own. Saying the
       second one is refused would send somebody to an admin for no reason; saying nothing at
       all was the bug. */
    bar.querySelector('.bcc-refused-msg').textContent = refused
      ? ('⚠ ' + refused + ' change' + (refused === 1 ? '' : 's') + ' could not be saved — ' + (refused === 1 ? 'it is' : 'they are') + ' still here on this device, nothing has been lost.')
      : ('⚠ ' + queued + ' change' + (queued === 1 ? '' : 's') + ' still waiting to save — ' + (queued === 1 ? 'it is' : 'they are') + ' held on this device and will keep retrying. Nothing has been lost.');
    bar.classList.add('show');
    placeOfflineBar(bar);
  }
  window.bccRefreshRefusedBar = refreshRefusedBar;
  /* THE OTHER HALF OF THE SAME RULE. A device that could not load the firm's records must not
     present its empty lists as facts — and until now it said nothing at all, because the
     offline bar only fires when the browser is offline and this failure happens online.
     Pinned, worded to name what the person is actually looking at, and offering the one thing
     that fixes it. Pages ALSO guard their own empty states (bootDataOk and its siblings); this
     is the firm-wide statement that covers the ones that cannot. */
  function refreshIncompleteBar() {
    if (!document.body) return;
    var bad = !!window._bccBootPullFailed;
    var bar = document.getElementById('bcc-incomplete-bar');
    if (!bad) { if (bar) bar.classList.remove('show'); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bcc-incomplete-bar';
      bar.className = 'bcc-offline bcc-incomplete';
      bar.innerHTML = '<span>⚠ This device could not load all of the firm’s records just now, so lists and counts on this page may be short. Nothing has been deleted.</span> <button type="button" class="bcc-incomplete-go">Reload</button>';
      (document.body || document.documentElement).appendChild(bar);
      bar.querySelector('.bcc-incomplete-go').onclick = function () { try { location.reload(); } catch (e) {} };
    }
    bar.classList.add('show');
    placeOfflineBar(bar);
  }
  window.bccRefreshIncompleteBar = refreshIncompleteBar;

  /* ---------- live sync (cross-device, near-real-time) ----------
   * Every visible tab polls the delta endpoint (?since=<cursor>) on a short
   * interval — an empty response is a few bytes, so idle cost is ~nothing.
   * When another user/device changed something, the changed docs land in
   * localStorage and ONE 'bcc-data-ready' event fires ({detail:{keys,live}}).
   * Nearly every page already re-renders on that event, so a schedule change
   * on one device appears on a co-worker's open screen within seconds.
   * Local unsent writes always win (pending keys are skipped), and identical
   * values are ignored, so your own pushes never echo back as "changes". */
  var LIVE_POLL_MS = 8000;
  var _livePollStarted = false, _liveBusy = false;
  /* APP-level permissions live in bcc-admin-config-v1, and a delta pull only ever asks for
     docs that changed AFTER the cursor — so the moment an admin grants someone a new app,
     every record that just became visible to them is OLDER than their cursor and never
     arrives: the newly-granted page shows nothing until the daily full pull happens to run.
     Watch our OWN row in that document and re-pull when it changes.
     Deliberately only the APP half: per-CLIENT access lives in bcc-qbo-company- docs, which
     are protected and never synced, so this cannot see it. That half is caught by the
     accessStamp the server publishes on /api/profile (see ACCESS_STAMP_KEY above) — do not
     re-word this comment to claim it covers client grants. */
  function myAccessFp() {
    try {
      var who = (window.bccUser && window.bccUser.userDetails) || '';
      if (!who) return '';
      var rec = _findUserRec(who);
      return rec ? JSON.stringify(rec) : '';
    } catch (e) { return ''; }
  }
  function forceFullPull() {
    try {
      // Rewind the cursor rather than clearing it: livePoll returns early when there is no
      // cursor, so clearing would leave this tab with no live updates at all until a reload.
      _origSetItem.call(localStorage, 'bcc-sync-since-v1', new Date(0).toISOString());
      // A rewound delta still can't carry legacy docs that have no updatedAt at all, so drop
      // the full-pull stamp too and let the next load do the real thing.
      _origRemoveItem.call(localStorage, 'bcc-sync-fullpull-at');
    } catch (e) {}
    setTimeout(function () { try { livePoll(); } catch (e) {} }, 250);   // after this poll's .finally clears _liveBusy
  }
  var _bootRetryAt = 0, _bootRetryWait = 15000;   // backoff, so a hard-down server is not hammered
  /* Set only for the poll that rewinds the cursor to the epoch — the one that genuinely
     re-delivers the whole tenant and can therefore restore the completeness claim. */
  var _recoveryPoll = false;
  function livePoll() {
    if (!signedIn || _liveBusy || document.hidden) return;
    _recoveryPoll = false;
    var since = ''; try { since = localStorage.getItem('bcc-sync-since-v1') || ''; } catch (e) {}
    var ts = since ? new Date(since).getTime() : NaN;
    if (isNaN(ts)) {
      /* NO CURSOR — which on a cold device means the bootstrap pull FAILED, because a
         successful one always stamps it. Returning here left the app empty for the entire
         session with no way back: every list rendering its empty state as a fact about the
         firm, and reloading the only cure. Rewind to the epoch so this poll becomes the full
         retry (the same device forceFullPull uses), backing off each time it does not take. */
      if (!window._bccBootPullFailed) return;   // genuinely nothing to recover from yet
      var nowB = Date.now();
      if (nowB < _bootRetryAt) return;
      _bootRetryAt = nowB + _bootRetryWait;
      _bootRetryWait = Math.min(_bootRetryWait * 2, 5 * 60 * 1000);
      try { _origSetItem.call(localStorage, 'bcc-sync-since-v1', new Date(0).toISOString()); } catch (e) { return; }
      since = new Date(0).toISOString();
      ts = 0;
      _recoveryPoll = true;
      console.info('[bcc-api] retrying the failed initial pull');
    }
    _liveBusy = true;
    fetch(API_BASE + '/data?since=' + encodeURIComponent(new Date(ts - 60 * 1000).toISOString()))
      .then(function (r) {
        /* An HTTP failure is NOT "no changes". Collapsing it to null left the cursor
           untouched and the tab silently stopped receiving anyone else's work — the failure
           mode this whole layer exists to avoid, in the one place nothing reported it. */
        if (!r.ok) { var e = new Error('poll HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      })
      .then(function (j) {
        _pollFailStreak = 0;
        if (_pollWasFailing) { _pollWasFailing = false; setSyncState('idle'); }
        var items = (j && j.items) || [];
        if (!items.length) return;
        var cfgIncoming = false;
        for (var ci = 0; ci < items.length; ci++) { if (items[ci] && items[ci].key === 'bcc-admin-config-v1') { cfgIncoming = true; break; } }
        var fpBefore = cfgIncoming ? myAccessFp() : '';
        var changed = [], maxUpd = since, pollFailed = 0, minFailedUpd = '';
        items.forEach(function (it) {
          if (!it || !it.key || it.data === undefined) return;
          if (it.updatedAt && it.updatedAt > maxUpd) maxUpd = it.updatedAt;
          if (pending.has(it.key) || heldInFlight(it.key) || outboxPendingAnyTab(it.key)) return; // an unsent — or still-saving — local write is newer, in THIS tab or another
          // Never let a DEVICE preference arrive from the server. Older builds pushed
          // these, so a tenant-wide copy may still exist in Cosmos; applying it would
          // keep overwriting this browser's own value forever.
          if (DEVICE_LOCAL_KEYS.indexOf(it.key) >= 0) return;
          var val = typeof it.data === 'string' ? it.data : JSON.stringify(it.data);
          if (localStorage.getItem(it.key) === val) return; // no real change
          // Same per-item guard as the bootstrap pull: one full-storage failure must not
          // abandon the rest of the batch. changed.push INSIDE the try — announcing a key
          // that never landed would have every listener re-render from the old value.
          try { _origSetItem.call(localStorage, it.key, val); changed.push(it.key); }
          catch (e) {
            pollFailed++;
            if (it.updatedAt && (!minFailedUpd || it.updatedAt < minFailedUpd)) minFailedUpd = it.updatedAt;
          }
        });
        // Same cursor clamp: a doc that did not land must stay eligible for the next delta.
        try {
          var pcur = maxUpd;   // same clamp as the bootstrap pull — see the note there
          if (minFailedUpd) { var pt = new Date(minFailedUpd).getTime(); pcur = isNaN(pt) ? '' : new Date(pt - 1).toISOString(); }
          if (pcur && pcur > since) _origSetItem.call(localStorage, 'bcc-sync-since-v1', pcur);
        } catch (e) {}
        /* Restore the completeness claim ONLY after a poll that actually re-delivered
           everything — i.e. the recovery poll, whose cursor was rewound to the epoch.
           An ORDINARY clean delta proves the server is reachable and nothing more: on the
           quota path a cursor IS stamped (clamped below the first failure), so the records
           that never landed sit BEFORE it and are never offered again. Clearing the flag
           there would restore the claim over a device that is still missing them. */
        if (!pollFailed && _recoveryPoll) {
          window._bccBootPullFailed = false;
          window._bccBootPullOk = true;
          _bootRetryWait = 15000;
          try { if (window.bccRefreshIncompleteBar) window.bccRefreshIncompleteBar(); } catch (e) {}
        }
        if (changed.length) {
          if (changed.indexOf('bcc-admin-config-v1') >= 0) {
            try { recomputePcPeople(); } catch (e) {}
            // Our own access just changed — anything it opened up predates the cursor.
            if (myAccessFp() !== fpBefore) forceFullPull();
          }
          window.dispatchEvent(new CustomEvent('bcc-data-ready', { detail: { keys: changed, live: true } }));
        }
        if (pollFailed) {
          console.warn('[bcc-api] ' + pollFailed + ' live update(s) could not be stored locally (storage full?) — they will be retried');
          /* Same withdrawal as the boot pull's. What landed is still applied; what is
             withdrawn is only the CLAIM that this device holds the whole picture — which is
             what the payroll/pay-app numbering gates and the "not loaded" empty states ask
             before they speak. The cursor is clamped below the first failure, so this repeats
             every cycle while storage is full: it is a state, not a blip. */
          window._bccBootPullFailed = true;
        }
      })
      .catch(function (e) {
        /* Say it ONCE, and say the right thing. A 401 is the routine mid-day session
           expiry and already has a message written for it; anything else is reported to
           the console and to the sync chip, which is what that chip is for. The poll keeps
           retrying either way — the cursor is untouched, so nothing is lost, but a tab that
           has silently stopped syncing must not look identical to one that is idle. */
        _pollFailStreak = (_pollFailStreak || 0) + 1;
        if (_pollFailStreak !== 1) return;
        _pollWasFailing = true;
        setSyncState('error');
        console.warn('[bcc-api] live sync poll failed (' + ((e && e.message) || 'network') + ') — retrying');
        if ((e && e.status) === 401 && window.bccNotify && !_pollAuthNotified) {
          _pollAuthNotified = true;
          window.bccNotify('Your sign-in has expired, so this page has stopped receiving updates from your team. Reload to sign back in.', 'warn', 0);
        }
      })
      .finally(function () { _liveBusy = false; });
  }
  function liveStart() {
    if (_livePollStarted || !signedIn) return;
    _livePollStarted = true;
    setInterval(livePoll, LIVE_POLL_MS);
    // Catch up the moment a backgrounded tab comes back.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) livePoll(); });
    window.addEventListener('focus', livePoll);
  }
  window.addEventListener('bcc-auth-ready', liveStart);

  /* ---------- People filter ----------
   * Rebuilds window.bccPeople from bccPeopleFull, dropping anyone marked
   * 'inactive' or 'hidden' in bcc-admin-config-v1.users. Called once at
   * bootstrap AND every time the admin config is saved during the session,
   * so dropdowns react immediately to status changes without a page
   * refresh. Fires bcc-users-ready after each rebuild so listeners
   * re-render with the new list.
   */
  function recomputePcPeople() {
    var live = (window.bccPeopleFull || []);
    if (!live.length) return;
    var inactiveKeys = new Set();
    try {
      var raw = localStorage.getItem('bcc-admin-config-v1');
      var adminCfg = raw ? JSON.parse(raw) : null;
      if (adminCfg && Array.isArray(adminCfg.users)) {
        adminCfg.users.forEach(function (u) {
          if (u && (u.status === 'inactive' || u.status === 'hidden')) {
            if (u.upn)   inactiveKeys.add(u.upn.toLowerCase());
            if (u.email) inactiveKeys.add(u.email.toLowerCase());
            if (u.name)  inactiveKeys.add(u.name.toLowerCase());
          }
        });
      }
    } catch (e) {}

    var activeOnly = live.filter(function (u) {
      if (inactiveKeys.has((u.upn || '').toLowerCase())) return false;
      if (inactiveKeys.has((u.mail || '').toLowerCase())) return false;
      if (inactiveKeys.has((u.displayName || '').toLowerCase())) return false;
      return true;
    });
    window.bccPeople = activeOnly.map(function (u) { return u.displayName; });
    // Full active-user objects (upn/mail/displayName) for "pick a user" dropdowns —
    // excludes anyone marked inactive/hidden. bccPeopleFull stays the UNFILTERED list
    // (admin management + resolving the name of an already-assigned inactive user).
    window.bccActivePeople = activeOnly;

    // If bcc-field-who points at a UPN/email or an inactive name, re-point it
    // to a current active display name (best-effort).
    var who = localStorage.getItem('bcc-field-who');
    if (who && window.bccPeople.indexOf(who) < 0) {
      var hit = activeOnly.find(function (u) { return u.upn === who || u.mail === who; });
      if (hit) _origSetItem.call(localStorage, 'bcc-field-who', hit.displayName);
    }
  }
  // Expose for admin.html to call directly after a save (faster than the
  // storage-hook fallback).
  window.bccRecomputePeople = function () {
    recomputePcPeople();
    window.dispatchEvent(new Event('bcc-users-ready'));
  };
  /* Ask Entra again, NOW. admin.html's "Refresh from Entra" button had only
     bccRecomputePeople() behind it, which re-derives the lists from the directory copy
     ALREADY in memory — so somebody hired this morning stayed missing however many times it
     was pressed, and a full reload was the only thing that actually re-asked. Resolves with
     the number of users so the caller can report it, and REJECTS on failure so a dead
     network cannot be reported as a successful refresh of a stale list. */
  window.bccRefreshUsers = function () {
    return fetch(API_BASE + '/users', { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var live = ((j && j.users) || []).filter(function (u) { return u && u.displayName; });
        // An empty directory is not an answer worth caching over a working list.
        if (!live.length) throw new Error('the directory came back empty');
        window.bccPeopleFull = live;
        try { _origSetItem.call(localStorage, 'bcc-users-cache-v1', JSON.stringify({ users: live, at: Date.now() })); } catch (e) {}
        recomputePcPeople();
        window.dispatchEvent(new Event('bcc-users-ready'));
        return live.length;
      });
  };

  /* Reusable "active users only" filter for ANY list of user objects
   * ({upn|userUpn, mail|email, displayName|name}). Drops anyone marked
   * inactive/hidden in bcc-admin-config-v1, so an inactive user disappears from
   * every assignment / owner / member / access dropdown across the app. Reads the
   * admin config directly so it works regardless of people-list load timing. */
  window.bccFilterActive = function (list) {
    var keys = new Set();
    try {
      var cfg = JSON.parse(localStorage.getItem('bcc-admin-config-v1') || 'null');
      if (cfg && Array.isArray(cfg.users)) cfg.users.forEach(function (u) {
        if (u && (u.status === 'inactive' || u.status === 'hidden')) {
          if (u.upn) keys.add(String(u.upn).toLowerCase());
          if (u.email) keys.add(String(u.email).toLowerCase());
          if (u.name) keys.add(String(u.name).toLowerCase());
        }
      });
    } catch (e) {}
    if (!keys.size) return (list || []).slice();
    return (list || []).filter(function (u) {
      if (!u) return false;
      return !keys.has(String(u.upn || u.userUpn || '').toLowerCase()) &&
             !keys.has(String(u.mail || u.email || '').toLowerCase()) &&
             !keys.has(String(u.displayName || u.name || '').toLowerCase());
    });
  };

  /* ---------- Identity-to-display-name helpers ----------
   * Throughout the app we have three identifiers for the same person:
   *   - UPN (lewis@bluecollarcoach.us)
   *   - mail (same in practice)
   *   - displayName ("Lewis Koljonen")
   * These helpers resolve any of them to a human-readable name using
   * window.bccPeopleFull (the live Entra user list). If the user isn't
   * in bccPeopleFull yet (network slow, anonymous, etc.) we fall back
   * to whatever identifier was passed in — never throw, never return
   * undefined. Safe to call before bcc-users-ready fires.
   *
   *   window.bccDisplayName('lewis@bluecollarcoach.us') → 'Lewis Koljonen'
   *   window.bccFirstName('lewis@bluecollarcoach.us')   → 'Lewis'
   *   window.bccDisplayName('')                             → ''
   */
  // Title-case a single word: "lyle" -> "Lyle", "MCDONALD" -> "Mcdonald".
  function bccTitleWord(w) {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }
  // Convert an email/UPN to a human-readable name when we have nothing else.
  //   "lyle@bluecollarcoach.us"          -> "Lyle"
  //   "lewis.koljonen@bluecollarcoach.us" -> "Lewis Koljonen"
  //   "jane_doe@x.com"                   -> "Jane Doe"
  function bccPrettifyEmail(s) {
    if (!s || s.indexOf('@') < 0) return s || '';
    var local = s.split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (!local) return s;
    return local.split(/\s+/).map(bccTitleWord).join(' ');
  }
  window.bccDisplayName = function (identifier) {
    if (!identifier) return '';
    var s = String(identifier).trim();
    if (!s) return '';
    var lc = s.toLowerCase();
    var full = window.bccPeopleFull || [];
    for (var i = 0; i < full.length; i++) {
      var u = full[i];
      if (!u) continue;
      if ((u.upn || '').toLowerCase() === lc)         return u.displayName || bccPrettifyEmail(s) || s;
      if ((u.mail || '').toLowerCase() === lc)        return u.displayName || bccPrettifyEmail(s) || s;
      if ((u.displayName || '').toLowerCase() === lc) return u.displayName;
    }
    // No people-list match. If the identifier is an email/UPN, prettify the
    // local part so we never show "lyle@bluecollarcoach.us" as a "name."
    if (s.indexOf('@') > 0) return bccPrettifyEmail(s);
    return s;
  };
  window.bccFirstName = function (identifier) {
    var name = window.bccDisplayName(identifier);
    if (!name) return '';
    // If somehow still an email (shouldn't happen given bccDisplayName above),
    // strip the domain as a last-ditch fallback.
    if (name.indexOf('@') > 0) name = bccPrettifyEmail(name);
    return name.trim().split(/\s+/)[0] || name;
  };

  /* ---------- Per-app role / permission helpers ----------
   * Each app (page) has a role per user, on top of the global admin/member
   * role. Levels: 'admin' > 'edit' > 'view' > 'none'. Stored on
   *   bcc-admin-config-v1.users[i].appPermissions = { crm: 'edit', ... }
   *
   * Defaults when appPermissions is absent on a user record:
   *   global role 'admin' -> 'admin' for every app
   *   global role 'member' (or anything else) -> 'edit' for the core member
   *     app set (see MEMBER_DEFAULT_APPS), 'none' for everything else.
   * The admin page is an exception: it always requires effective 'admin'
   * unless the user.role is 'admin' (admins implicitly admin every app).
   *
   * To gate a page, call window.bccEnforcePagePermission(appKey, minLevel)
   * during page init. Returns the user's level. If the user lacks the level,
   * shows an access-denied overlay and freezes the page.
   */
  window.BCC_APP_KEYS = [
    'home','myday','sessions','dashboard','crm','jobs','scheduler','marketing',
    'bookkeeping','documents','rates','chat','training','events','kb','admin'
  ];
  // Filename (with .html) -> app key. Used to map location.pathname to a key.
  window.BCC_PAGE_TO_APP = {
    '':              'home',
    'index.html':    'home',
    'myday.html':    'myday',
    'sessions.html': 'sessions',
    'dashboard.html':'dashboard',
    'crm.html':      'crm',
    'crm-companies.html': 'crm',
    'jobs.html':     'jobs',
    'scheduler.html':'scheduler',
    'marketing.html':'marketing',
    'bookkeeping.html':'bookkeeping',
    'documents.html':'documents',
    'rates.html':    'rates',
    'chat.html':     'chat',
    'training.html': 'training',
    'events.html':   'events',
    'kb.html':       'kb',
    'admin.html':    'admin',
    'activity.html': 'admin',   // activity log is admin-tier
    'guide.html':    'home'     // help page available to anyone with home
  };
  // 'tasks' is a bookkeeping-specific tier: the app is reachable (same rank as
  // view) but shows ONLY per-client tasks — no financials. Enforced server-side
  // by the companies endpoint and client-side by bookkeeping.html gating.
  var LEVEL_RANK = { none: 0, tasks: 1, view: 1, edit: 2, admin: 3 };
  // Apps a non-admin (member) can use by default, with no per-app override.
  // Everything not listed here (CRM, Engagements, Marketing, Rate Sheet,
  // Admin) defaults to 'none' for members. 'home' is included so members can
  // reach the landing/navigation hub.
  window.BCC_MEMBER_DEFAULT_APPS = {
    home: 1, myday: 1, sessions: 1, dashboard: 1, scheduler: 1, bookkeeping: 1,
    documents: 1, chat: 1, training: 1, events: 1, kb: 1
  };
  function _adminCfg() {
    try { return JSON.parse(localStorage.getItem('bcc-admin-config-v1') || 'null'); } catch (e) { return null; }
  }
  // Must match the SERVER's lookup byte-for-byte (api/src/index.js appTierFor /
  // isAppAdmin, which both match on upn OR email). Matching on upn alone meant that
  // for any admin-config row whose upn differs from the SWA userDetails, the client
  // silently found no record and fell back to defaults while the server DID find it
  // and applied the explicit appPermissions — so the UI showed one level of access
  // and every request enforced another.
  function _findUserRec(upn) {
    var cfg = _adminCfg();
    if (!cfg || !cfg.users) return null;
    var lc = String(upn || '').toLowerCase();
    for (var i = 0; i < cfg.users.length; i++) {
      var u = cfg.users[i];
      if ((u.upn || '').toLowerCase() === lc || (u.email || '').toLowerCase() === lc) return u;
    }
    return null;
  }
  window.bccGetAppPermission = function (appKey, upn) {
    if (!appKey) return 'none';
    var who = upn || (window.bccUser && window.bccUser.userDetails) || '';
    if (!who) return 'none'; // anonymous -> no app permission
    var cfg = _adminCfg();
    var rec = _findUserRec(who);
    // Inactive users are blocked everywhere. 'hidden' counts too — the SERVER's
    // appTierFor() blocks both, so treating hidden as merely a dropdown-visibility
    // flag here handed those users a fully working CRM/Jobs/Marketing/Rates UI whose
    // every read came back filtered and every write 403'd.
    if (rec && (rec.status === 'inactive' || rec.status === 'hidden')) return 'none';
    /* The Admin app is decided by the ROLE and nothing else, and it is checked BEFORE any
       per-app override. The server's admin gate (isAppAdmin) reads the owner list, the SWA
       'administrator' role and role==='admin'; it has never looked at appPermissions.admin.
       An override here therefore handed someone the nav link and a fully rendered Admin
       Center whose every endpoint then refused them — while the admin who set it believed
       they had delegated admin and had not. bccIsAdmin() honours the same recovery paths the
       server uses (BCC_OWNER_UPNS, the SWA 'administrator' role, /api/profile), and its
       narrow bootstrap only fires on a truly empty admin-config doc. */
    if (appKey === 'admin') return (window.bccIsAdmin && window.bccIsAdmin()) ? 'admin' : 'none';
    // Per-app override wins if explicitly set
    var perm = rec && rec.appPermissions && rec.appPermissions[appKey];
    if (perm && LEVEL_RANK[perm] != null) return perm;
    // Fall back to global role
    var isAdmin = rec && rec.role === 'admin';
    if (isAdmin) return 'admin';
    // Non-admin (member) default: edit on the core member app set, else none.
    return window.BCC_MEMBER_DEFAULT_APPS[appKey] ? 'edit' : 'none';
  };
  window.bccCanAccess = function (appKey, upn) {
    return LEVEL_RANK[window.bccGetAppPermission(appKey, upn)] >= LEVEL_RANK.view;
  };
  window.bccCanEdit = function (appKey, upn) {
    return LEVEL_RANK[window.bccGetAppPermission(appKey, upn)] >= LEVEL_RANK.edit;
  };
  /* Has the bootstrap pull actually delivered? The POSITIVE fact, not the absence of the
     negative one: _bccBootPullFailed is undefined while the pull is still in flight, and the
     lists that ask this render from parse time. Every empty state that says something about
     the FIRM — "no contacts yet", "no events yet", "0 sessions today", "no to-dos" — has to
     ask before it speaks, or a failed request is presented to a bookkeeper as their records
     being gone. (bcc-api.js itself raises a banner too; this is what lets each page word its
     own list honestly.) */
  window.bccDataComplete = function () {
    return !window._bccBootPullFailed && window._bccBootPullOk === true;
  };
  /* The write gate. Returns TRUE when the write must not happen, having already told the
     person why — the same shape as each page's local refuse helper, so it reads the same at
     every call site. `what` names the thing in their words: "message", "session", "article". */
  window.bccRefuseIfNoEdit = function (appKey, what) {
    /* Identity first. bccGetAppPermission answers 'none' for everyone until the principal
       lands, and refusing every write for the first moment of every page load would tell a
       legitimate user they are view-only. While it is unknown, let the SERVER decide — it is
       the real gate. */
    if (!window.bccUser || !window.bccUser.userDetails) return false;
    if (window.bccCanEdit(appKey)) return false;
    var thing = what || 'change';
    (window.bccNotify || alert)('Your access to this section is view-only, so that ' + thing + ' was not saved. Ask an admin for edit access.', 'warn', 9000);
    return true;
  };
  window.bccCurrentAppKey = function () {
    var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    return window.BCC_PAGE_TO_APP[here] || 'home';
  };
  window.bccEnforcePagePermission = function (appKey, minLevel) {
    appKey = appKey || window.bccCurrentAppKey();
    minLevel = minLevel || 'view';
    var level = window.bccGetAppPermission(appKey);
    if (LEVEL_RANK[level] >= LEVEL_RANK[minLevel]) return level;
    // Blocked. Render a polite overlay; don't ever silently render the page.
    var overlay = document.createElement('div');
    overlay.id = 'bcc-access-denied';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,20,0.94);color:#f6f6f4;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:Inter,system-ui,sans-serif;';
    var label = ({home:'Home',myday:'My Day',sessions:'Sessions',crm:'CRM',jobs:'Engagements',scheduler:'Scheduler',marketing:'Marketing',bookkeeping:'Bookkeeping',documents:'Documents',rates:'Rate Sheet',chat:'Team Chat',training:'Training',events:'Events',kb:'Knowledge Base',admin:'Admin'})[appKey] || appKey;
    overlay.innerHTML =
      '<div style="font-family:\'Source Serif 4\',Georgia,serif;font-size:26px;font-weight:700;letter-spacing:0.4px;margin-bottom:10px;">Access restricted</div>' +
      /* Word it for the REAL state. Deliberately still blocking when the pull failed: neither
         admin.html nor activity.html has a gate of its own, so skipping this on a transient
         500 would render Admin > Users & Roles to any signed-in member - fail-open, and worse
         than the message being wrong. */
      (window._bccBootPullFailed
        ? '<div style="color:rgba(255,255,255,0.7);max-width:420px;line-height:1.5;font-size:14px;">Your permissions could not be loaded just now, so <strong>' + label + '</strong> is closed as a precaution. Reload the page — if this keeps happening, tell an admin.</div>'
        : '<div style="color:rgba(255,255,255,0.7);max-width:420px;line-height:1.5;font-size:14px;">Your account doesn\'t have permission to open <strong>' + label + '</strong>. Ask an admin in Admin &rsaquo; Users &amp; Roles to grant access.</div>') +
      '<a href="/index.html" style="margin-top:22px;color:#d4b67a;text-decoration:none;border:1px solid rgba(168,136,74,0.4);border-radius:8px;padding:9px 18px;font-weight:600;font-size:13px;">Back to home</a>';
    document.body.appendChild(overlay);
    // Prevent further scripts from operating on the page (best-effort).
    document.documentElement.style.overflow = 'hidden';
    return level;
  };

  /* ---------- bootstrap ---------- */
  // Hard-coded company domain allowlist. Anyone signed in via Entra whose UPN/email
  // doesn't end with one of these gets signed out — even if Microsoft admit them
  // (e.g. accidental guest invite).
  // The SWA + Entra-tenant restriction (configured in staticwebapp.config.json
  // with openIdIssuer pinned to BCC's tenant GUID) already prevents anyone
  // outside the tenant from signing in. Layering a second client-side string
  // match on userDetails was causing false-positive 403s when SWA returned a
  // privacy-masked userDetails value. Treat any authenticated tenant user as
  // allowed; rely on the role check + BCC_OWNER_UPNS for actual privilege.
  function domainAllowed(principal) {
    return !!principal;
  }

  async function bootstrap() {
    // Visible "something is happening" bar across the very top of every page
    // while we fetch identity + cloud state. Removed by finishProgress() at
    // the end of bootstrap, regardless of success.
    startProgress();

    // 1) Detect auth via SWA's built-in /.auth/me endpoint
    var authAnswered = false;
    try {
      var r = await fetch('/.auth/me', { credentials: 'include' });
      if (r.ok) {
        var j = await r.json();
        user = j && j.clientPrincipal ? j.clientPrincipal : null;
        signedIn = !!user;
        authAnswered = true;    // a principal-less 200 IS an answer: this device is anonymous
      }
    } catch (e) {
      // Offline, DNS, or not deployed on SWA. NOT an answer — see _authUnknown.
    }
    /* sw.js deliberately bypasses /.auth/ (it must never be cached), so an offline boot always
       lands here, and it precaches the pages people open in the field. Remember that we never
       got a verdict so writes are still captured and retryAuthBootstrap can ask again. */
    _authUnknown = !signedIn && !authAnswered;

    // Recover writes this device queued but never got to send — a tab closed while
    // offline, a reload mid-retry, or an edit made in the window before /.auth/me
    // resolved. Must run BEFORE the pull is applied below: the `pending.has(...)`
    // guards there are what keep the server's older copy from landing on top, and they
    // can only see what is already in `pending`.
    if (signedIn) {
      // A different person on this device: their personal docs are not ours to replay,
      // and the delta cursor is per-device, so keep it honest and force a full pull.
      try {
        var _nowWho = String((user && user.userDetails) || '').toLowerCase();
        var _prevWho = localStorage.getItem('bcc-device-last-upn');
        if (_nowWho && _prevWho && _prevWho !== _nowWho) {
          var _stale = [];
          for (var _si = 0; _si < localStorage.length; _si++) {
            var _sk = localStorage.key(_si);
            // 'bccnc-' too: the notification centre's items and its fired/seen markers
            // are per-PERSON but deliberately not bcc- keys, so nothing else clears them
            // — the next user inherited the previous one's bell contents.
            if (_sk && (_sk.indexOf('bcc-mytasks-') === 0 || _sk.indexOf('bcc-daily-log-') === 0 || _sk.indexOf('bccnc-') === 0)) _stale.push(_sk);
          }
          // _origRemoveItem queues nothing, so the previous user's SERVER copies are
          // untouched — they come back on their next pull. This only clears this device.
          _stale.forEach(function (k) { _origRemoveItem.call(localStorage, k); });
          _origRemoveItem.call(localStorage, 'bcc-sync-since-v1');
          _origRemoveItem.call(localStorage, 'bcc-sync-fullpull-at');
        }
        if (_nowWho) _origSetItem.call(localStorage, 'bcc-device-last-upn', _nowWho);
      } catch (e) {}
      try {
        var _recovered = outboxRehydrate();
        if (_recovered) console.info('[bcc-api] recovered ' + _recovered + ' unsent change(s) from the outbox');
      } catch (e) {}
      /* ...and re-arm the push for whatever is ALREADY in `pending` from this same page.
         Bootstrap had no flush() of its own: the only trigger was rehydrate's `if (kept)`.
         A write made while /.auth/me had not answered (hotel wifi, a slow edge) sits in
         `pending` — flush() refuses it because !signedIn — and its outbox copy is then
         destroyed by the untrusted-drop rule, which is correct for attribution but leaves the
         in-memory copy as the only surviving one, with nothing scheduled to send it. The user
         is told it is queued and it never goes; on the next load the pull writes the server's
         older copy over it and the edit is gone. It only survived if she happened to make some
         OTHER write in the same tab.
         Personal keys belonging to somebody else are dropped first, on the same rule
         outboxRehydrate applies to the durable copy: the pre-auth capture at the top of this
         file cannot know whose they are, and pushing A's day log under B is refused by
         ownsPersonalKey — which fails the WHOLE batch and hands B a sync error for a record
         she never touched. */
      try {
        if (pending.size) {
          var _foreign = [];
          pending.forEach(function (_v, k) {
            if (/^bcc-(daily-log|mytasks|emailsig|chat-last-read)-/.test(k)
                && !bccKeyOwnerOk(k, (user && user.userDetails) || '')) _foreign.push(k);
          });
          _foreign.forEach(function (k) { pending.delete(k); });
          if (_foreign.length) console.info('[bcc-api] held back ' + _foreign.length + ' personal write(s) belonging to another account');
          if (pending.size) schedulePush();
        }
      } catch (e) {}
    }

    var _accessChanged = false;   // set from /api/profile's accessStamp, read by the pull below
    var _pendingStamp = '';       // ...and only written once that pull has actually landed
    // 1b) Ask the server for its admin verdict (honors BCC_OWNER_UPNS and
    //     SWA 'administrator' role server-side, which the client wouldn't
    //     otherwise know about). Best-effort; if the call fails, the
    //     client gate falls back to local cfg lookup in bccIsAdmin().
    if (signedIn) {
      try {
        var pr = await fetch(API_BASE + '/profile', { credentials: 'include' });
        if (pr.ok) {
          var pj = await pr.json();
          if (pj && typeof pj.isAppAdmin === 'boolean') {
            window.__pcServerIsAdmin = pj.isAppAdmin;
          }
          /* accessStamp changes whenever the set of clients this account may see (or its
             bookkeeping tier, or its admin flag) changes. A delta pull only asks for docs
             changed AFTER the cursor, so everything a NEW grant just opened up is older than
             the cursor and would never arrive — the client would read as empty until the daily
             full pull. Per-client access lives in bcc-qbo-company- docs, which are protected
             and never synced, so the browser cannot detect this on its own; the server tells
             us. Read here, one step BEFORE the pull below chooses delta or full. */
          if (pj && pj.accessStamp) {
            var prevStamp = '';
            try { prevStamp = localStorage.getItem(ACCESS_STAMP_KEY) || ''; } catch (e) {}
            // Only on a CHANGE — a first-ever stamp must not send every device in the firm
            // into a full pull on the deploy that ships this.
            if (prevStamp && prevStamp !== pj.accessStamp) _accessChanged = true;
            /* Held, NOT stored yet. Storing it here consumed the signal even when the pull it
               was supposed to force then FAILED (offline, HTTP 500) — the next load would see
               a matching stamp, take the delta path again, and the newly granted client would
               stay empty until the daily full pull. It is written below, once a full pull has
               actually landed. */
            _pendingStamp = pj.accessStamp;
            if (!prevStamp) { try { _origSetItem.call(localStorage, ACCESS_STAMP_KEY, pj.accessStamp); } catch (e) {} }
          }
        }
      } catch (e) { /* swallow — fall back to client-side check */ }
    }

    // 1a) Domain enforcement — only @bluecollarcoach.us (or .onmicrosoft.com)
    if (signedIn && !domainAllowed(user)) {
      var who = (user && user.userDetails) || 'unknown';
      console.warn('[bcc-api] domain not allowed:', who);
      // Record the denied attempt BEFORE we redirect — once-per-session so
      // a stuck loop doesn't flood the audit log.
      try {
        if (!sessionStorage.getItem('bcc-audit-denied')) {
          sessionStorage.setItem('bcc-audit-denied', '1');
          // Inline call (window.bccAudit isn't defined yet at this point in bootstrap).
          fetch(API_BASE + '/audit', {
            method: 'POST', keepalive: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'signin-denied', path: location.pathname, meta: { who: who } })
          }).catch(function () {});
        }
      } catch (e) {}
      // Avoid loop if already on /403
      if (!location.pathname.endsWith('/403.html')) {
        location.replace('/.auth/logout?post_logout_redirect_uri=' +
          encodeURIComponent(location.origin + '/403.html?reason=domain&who=' + encodeURIComponent(who)));
        return;
      }
    }

    window.bccUser = user;

    // 2) If signed in, fire /api/data and /api/users in PARALLEL. They're
    //    independent endpoints — there's no reason to wait for one before
    //    starting the other. Cuts the bootstrap blocking time in half on
    //    most page loads because /api/users (Graph) is the slow one.
    if (signedIn) {
      // DELTA PULL: after the first full sync, only ask for docs that changed
      // since the last visit (?since=). Cuts the biggest recurring page-load
      // cost (the full firm-wide doc pull) to near-zero. A full pull still
      // runs once a day to self-heal (legacy docs, clock skew, missed writes).
      var SYNC_SINCE_KEY = 'bcc-sync-since-v1', SYNC_FULL_KEY = 'bcc-sync-fullpull-at';
      var _since = '', _lastFull = 0;
      try { _since = localStorage.getItem(SYNC_SINCE_KEY) || ''; _lastFull = +(localStorage.getItem(SYNC_FULL_KEY) || 0) || 0; } catch (e) {}
      // _accessChanged: a delta cannot carry records that were already there when access
      // was granted, so this load has to be a full one.
      var useDelta = !!_since && !_accessChanged && (Date.now() - _lastFull) < 24 * 60 * 60 * 1000;
      var dataUrl = API_BASE + '/data';
      if (useDelta) {
        // 5-minute overlap absorbs clock skew between writers.
        var sinceTs = new Date(_since).getTime();
        if (!isNaN(sinceTs)) dataUrl += '?since=' + encodeURIComponent(new Date(sinceTs - 5 * 60 * 1000).toISOString());
        else useDelta = false;
      }
      /* Remember a failed pull. The permission overlay asserts "your account doesn't have
         permission" from whatever config happens to be in localStorage - which, on a cold
         browser after a failed pull, is nothing at all. That reads as a deliberate denial.
         BOTH failure shapes: fetch only REJECTS on a network error, so catching alone missed
         the HTTP 500 the comment was written for - the overlay stayed wrong in exactly the
         case it was meant to fix. */
      /* Read by the prune below: a record touched after this moment cannot be spoken to by
         this response, whoever touched it. */
      _pullIssuedAt = Date.now();
      var dataPromise = fetch(dataUrl).then(function (r) {
        /* ONLY the negative here. The positive — "this device holds what the firm holds" — is
           not a fact about the response headers; it is a fact about the body having been read
           and every record having been stored, and it is stamped at the END of that work
           below. Setting it here meant a body that failed to parse, or an apply loop that
           threw part-way, still reported a complete pull to the numbering gates and the empty
           states that ask this before they make a claim about a client. */
        if (!r || !r.ok) window._bccBootPullFailed = true;
        return r;
      }).catch(function (e) {
        console.warn('[bcc-api] initial pull failed', e);
        window._bccBootPullFailed = true;
        return null;
      });
      var usersPromise = fetch(API_BASE + '/users').catch(function (e) {
        console.warn('[bcc-api] users pull failed — dropdowns will be empty until Entra is reachable', e);
        return null;
      });

      // Process /api/data first because /api/users filter needs the admin
      // config that came from it.
      try {
        var r = await dataPromise;
        if (r && r.ok) {
          var j = await r.json();
          var maxUpd = _since || '';
          // Only a FULL pull is authoritative about what still EXISTS: a delta pull
          // carries just the changed docs, so absence from it means nothing.
          var seenKeys = useDelta ? null : new Set();
          var pullFailed = 0, minFailedUpd = '';
          (j.items || []).forEach(function (it) {
            if (!it || !it.key) return;
            if (seenKeys) seenKeys.add(it.key); // server still has this doc
            if (it.data === undefined) return;
            if (it.updatedAt && it.updatedAt > maxUpd) maxUpd = it.updatedAt;
            if (pending.has(it.key) || heldInFlight(it.key) || outboxPendingAnyTab(it.key)) return; // newer local write queued (or still saving), in THIS tab or another
            if (DEVICE_LOCAL_KEYS.indexOf(it.key) >= 0) return; // device preference (see setItem)
            var val = typeof it.data === 'string' ? it.data : JSON.stringify(it.data);
            // Per-item, because a QuotaExceededError on ONE document used to throw straight
            // out of this forEach: every remaining doc was skipped and the cursor stamps
            // below never ran, so SYNC_FULL_KEY stayed unwritten and every later pull was a
            // full pull that hit the same wall — the sync never recovered on its own.
            try { _origSetItem.call(localStorage, it.key, val); }
            catch (e) {
              pullFailed++;
              if (it.updatedAt && (!minFailedUpd || it.updatedAt < minFailedUpd)) minFailedUpd = it.updatedAt;
            }
          });
          // DELETIONS: the loop above only ever WRITES keys, so a record another
          // user deleted lived on in this browser indefinitely — the page still
          // listed it, and the next local write re-uploaded it and resurrected it
          // for everyone. The server hard-deletes with no tombstone, so "missing
          // from a full pull" is the only signal we get. Restricted to
          // PRUNABLE_PREFIXES, because for every other family absence has an
          // innocent explanation (see that list).
          // Guarded on a NON-EMPTY response: an empty full pull is far more likely
          // a server fault or a session that just lost its access than "the firm
          // deleted everything", and acting on it would be unrecoverable.
          if (seenKeys && seenKeys.size) {
            var gone = [];
            for (var pi = 0; pi < localStorage.length; pi++) {
              var pk = localStorage.key(pi);
              if (!pk || seenKeys.has(pk) || pending.has(pk) || heldInFlight(pk) || outboxPendingAnyTab(pk)) continue; // queued — or still-saving — local write wins, any tab
              var prunable = false;
              for (var px = 0; px < PRUNABLE_PREFIXES.length; px++) {
                if (pk.indexOf(PRUNABLE_PREFIXES[px]) === 0) { prunable = true; break; }
              }
              if (!prunable) continue;
              /* "Absent from the server" only means DELETED for a record the server once had.
                 A record created HERE since the last full pull has simply not been pushed yet
                 — and a write made before /.auth/me resolved is not even in the outbox to
                 vouch for it (only the four OFFLINE_OWNED_PREFIXES families are captured that
                 early), so the checks above cannot see it. Pruning on age alone destroyed it.
                 Measured against WHEN THIS PULL WAS ISSUED, not against the previous full
                 pull. The old test asked "was this stamped since the last full pull", which a
                 record a COLLEAGUE edited and a delta pull delivered passes just as easily —
                 the pull writes their copy verbatim, stamp and all — so a record they later
                 deleted was spared on every other browser and the next local write
                 resurrected it for the firm. Asking "was this touched after we asked the
                 server?" is the question that was actually meant: if it was, this response
                 cannot speak to it; if it was not, absent really does mean deleted. */
              /* Written HERE in this session, and the server does not have it. Almost always
                 a record created before /.auth/me answered — too early for the outbox to
                 capture, and necessarily stamped BEFORE the full pull that follows on the
                 same page load, so the age test below cannot save it. Provenance can.
                 Only ever makes the prune less willing, and only for the life of the tab. */
              if (_localMints.has(pk)) continue;
              var fresh = false;
              try {
                var pv = JSON.parse(localStorage.getItem(pk) || 'null');
                var stamp = pv && (pv.updatedAt || pv.createdAt);
                if (stamp) { var st = new Date(stamp).getTime(); fresh = !isNaN(st) && st >= (_pullIssuedAt || 0); }
              } catch (e) {}
              if (fresh) continue;
              gone.push(pk);
            }
            // Collect first, remove second — removing mid-scan reindexes localStorage
            // and would skip keys. _origRemoveItem, NOT removeItem: the doc is already
            // gone server-side, so the hooked version would queue a pointless DELETE,
            // and a refused key poisons the whole push batch (same reasoning as the
            // signature purge below).
            gone.forEach(function (k) { _origRemoveItem.call(localStorage, k); });
            if (gone.length) console.info('[bcc-api] dropped ' + gone.length + ' record(s) deleted by someone else');
          }
          try {
            // Never advance the cursor past a doc that did NOT land. The server filters
            // deltas on `updatedAt > since`, so stamping over a failed write means that doc
            // is never offered again — the browser keeps a permanently stale copy, and the
            // first local edit to it pushes that stale value back up and reverts the newer
            // server copy for everyone. Leaving the cursor short costs one re-fetch.
            // Advance to just BELOW the earliest failure rather than requiring the whole
            // batch to precede it: maxUpd is the maximum timestamp seen, so `maxUpd <
            // minFailedUpd` could never be true once anything failed, and the cursor was
            // pinned forever — every later pull re-fetched the entire tenant.
            var cursor = maxUpd;
            if (minFailedUpd) {
              var mt = new Date(minFailedUpd).getTime();
              cursor = isNaN(mt) ? '' : new Date(mt - 1).toISOString();
            }
            if (cursor && cursor > (_since || '')) _origSetItem.call(localStorage, SYNC_SINCE_KEY, cursor);
            // Likewise, only record a completed full pull if it actually completed. With
            // failures, the next load legitimately does another full pull — harmless now
            // that the items which DID fit have already been applied.
            if (!useDelta && !pullFailed) {
              _origSetItem.call(localStorage, SYNC_FULL_KEY, String(Date.now()));
              // The full pull that the access change asked for has landed — only now is the
              // new stamp true of what this device holds.
              if (_pendingStamp) { try { _origSetItem.call(localStorage, ACCESS_STAMP_KEY, _pendingStamp); } catch (e) {} }
            }
          } catch (e) {}
          /* HERE. The body was read, every item was applied, the prune has run. Only now is
             it true that an empty family on this device means an empty family at the firm. */
          if (!pullFailed) window._bccBootPullOk = true;
          if (pullFailed) {
            console.warn('[bcc-api] ' + pullFailed + ' record(s) could not be stored locally (storage full?) — they will be retried');
            /* And say so where it counts. Pages ask _bccBootPullOk before treating an empty
               local family as fact — "this client has no certified payrolls", "no sessions
               yet", "nothing due" — and before minting a number from max() over that family.
               A pull that fetched everything and stored some of it is exactly the case those
               guards exist for, so it must read as NOT ok. The records that did land are
               still applied; only the claim of completeness is withdrawn. */
            window._bccBootPullFailed = true;
          }
        }
      } catch (e) {
        /* This wraps READING and APPLYING the body — a parse failure, or a throw part-way
           through the item loop. Warning to the console and leaving the flags alone meant a
           half-applied pull still answered "complete" to every guard that asks. */
        console.warn('[bcc-api] initial pull failed', e);
        window._bccBootPullFailed = true;
        window._bccBootPullOk = false;
      }

      // 2b) One-time purge of OTHER people's email signatures.
      // These are per-user docs, but before they were owner-scoped server-side
      // the bulk pull shipped everyone's copy to everyone, so they're sitting in
      // browsers that synced during that window. They're never read (the app
      // only ever reads your own key) — this just clears the stragglers.
      // _origRemoveItem, NOT removeItem: the hooked version would queue a DELETE
      // for a doc this user doesn't own, which the server now rejects — and a
      // refused key poisons the whole push batch.
      try {
        if (user && user.userDetails && !localStorage.getItem('bcc-sigpurge-v1')) {
          var mineSig = 'bcc-emailsig-' + String(user.userDetails).toLowerCase().replace(/[^a-z0-9]+/g, '-');
          var stale = [];
          for (var si = 0; si < localStorage.length; si++) {
            var sk = localStorage.key(si);
            // ...unless it is still queued (or parked) unsent, in which case this local copy
            // is the LAST one in existence and removing it destroys that person's edit.
            if (sk && sk.indexOf('bcc-emailsig-') === 0 && sk !== mineSig && !outboxHas(sk)) stale.push(sk);
          }
          stale.forEach(function (k) { _origRemoveItem.call(localStorage, k); });
          if (stale.length) console.info('[bcc-api] cleared ' + stale.length + " cached signature(s) belonging to other users");
          _origSetItem.call(localStorage, 'bcc-sigpurge-v1', String(Date.now()));
        }
      } catch (e) {}

      // 3) Seed bcc-field-who from the signed-in identity. The guard used to be
      //    "only if absent", so on a shared browser the SECOND person to sign in kept
      //    the first person's name — and that value is what stamps chat messages and
      //    created records, so their work was attributed to someone else. Compare
      //    against who it was seeded FOR, not merely whether it exists, so a genuine
      //    manual override by the same user still survives.
      if (user && user.userDetails) {
        var seededFor = localStorage.getItem('bcc-field-who-upn');
        var meNow = String(user.userDetails).toLowerCase();
        if (seededFor !== meNow) {
          _origSetItem.call(localStorage, 'bcc-field-who', user.userDetails);
          _origSetItem.call(localStorage, 'bcc-field-who-upn', meNow);
        }
      }

      // 4) Active Entra users, STALE-WHILE-REVALIDATE: apply the cached
      //    directory instantly (dropdowns ready with zero Graph wait), then
      //    refresh from the network in the background and re-fire
      //    bcc-users-ready if it changed. First-ever load still awaits.
      //   window.bccPeopleFull -> every active Entra user (admin uses this so it
      //     can show & manage all of them, including ones marked Inactive in app)
      //   window.bccPeople     -> display names, FILTERED to exclude users marked
      //     Inactive in bcc-admin-config-v1. This is what every dropdown uses.
      var USERS_CACHE_KEY = 'bcc-users-cache-v1';
      var applyUsers = function (live, persist) {
        window.bccPeopleFull = live;
        recomputePcPeople();
        if (persist) { try { _origSetItem.call(localStorage, USERS_CACHE_KEY, JSON.stringify({ users: live, at: Date.now() })); } catch (e) {} }
        /* Actually fire it. The old comment claimed recomputePcPeople did, and it does not —
           so the BACKGROUND directory refresh updated bccPeople silently and every assignee
           picker and name label kept showing the cached list until the next full reload. */
        window.dispatchEvent(new Event('bcc-users-ready'));
      };
      var cachedUsers = null;
      try { var cu = JSON.parse(localStorage.getItem(USERS_CACHE_KEY) || 'null'); if (cu && Array.isArray(cu.users) && cu.users.length) cachedUsers = cu.users; } catch (e) {}
      /* THROW on a non-2xx. fetch does not reject on a 500, so mapping it to null made a
         throttled Graph or a lapsed consent indistinguishable from "this firm has no users":
         on a cold device (no cache) bccPeopleFull stayed undefined and every assignee picker,
         owner dropdown and name label came up empty with nothing logged, no toast and no
         event. The catch below now has something to catch. */
      var consumeUsers = function (ur) {
        if (!ur) throw new Error('no response from the directory');
        if (!ur.ok) { var e = new Error('directory HTTP ' + ur.status); e.status = ur.status; throw e; }
        return ur.json().then(function (uj) { return (uj.users || []).filter(function (u) { return u && u.displayName; }); });
      };
      try {
        if (cachedUsers) {
          applyUsers(cachedUsers, false);
          usersPromise.then(consumeUsers).then(function (live) {
            if (live && live.length && JSON.stringify(live) !== JSON.stringify(cachedUsers)) applyUsers(live, true);
          }).catch(function (e) { console.warn('[bcc-api] users refresh failed', e); });
        } else {
          /* The COLD path: no cached directory at all, so a failure here is the difference
             between "empty because that is the truth" and "empty because we could not ask".
             Say which — an empty picker that explains itself is recoverable; a silent one
             sends someone hunting for a colleague who is not missing. */
          try {
            var live0 = await usersPromise.then(consumeUsers);
            if (live0 && live0.length) applyUsers(live0, true);
            else console.warn('[bcc-api] the directory came back empty');
          } catch (ue) {
            console.warn('[bcc-api] users pull failed', ue);
            if (window.bccNotify) window.bccNotify('The staff directory could not be loaded (' + ((ue && ue.message) || 'no response') + '), so name and assignee lists on this page will be empty. Reload to try again.', 'warn', 10000);
          }
        }
      } catch (e) {
        console.warn('[bcc-api] users response parse failed', e);
      }
    }

    injectAuthChip();
    finishProgress();

    /* The once-per-tab flags below are scoped to the TAB, not the person. Signing out and
       back in as someone else reuses the same sessionStorage, so the second user's
       sign-in went unaudited and their configured landing page was ignored — they landed
       wherever the first user's preference had put them. Key the flags to the identity
       and clear them when it changes. */
    try {
      var _sessWho = String((user && user.userDetails) || '').toLowerCase();
      if (_sessWho && sessionStorage.getItem('bcc-session-upn') !== _sessWho) {
        sessionStorage.removeItem('bcc-landing-applied');
        sessionStorage.removeItem('bcc-audit-signin');
        sessionStorage.removeItem('bcc-audit-denied');
        sessionStorage.setItem('bcc-session-upn', _sessWho);
      }
    } catch (e) {}

    // Per-user landing page redirect: if the signed-in user has a
    // landingPage configured in admin-config AND we landed on the home
    // page, send them straight to their preferred page. Only fires once
    // per tab (sessionStorage flag) so it doesn't fight back-button.
    try {
      if (signedIn && !sessionStorage.getItem('bcc-landing-applied')) {
        sessionStorage.setItem('bcc-landing-applied', '1');
        var here = (location.pathname || '/').toLowerCase();
        var onHome = here === '/' || here.endsWith('/index.html');
        if (onHome) {
          var cfg = null;
          try { cfg = JSON.parse(localStorage.getItem('bcc-admin-config-v1') || 'null'); } catch (e) {}
          var meUpn = ((user && user.userDetails) || '').toLowerCase();
          var rec = cfg && cfg.users && cfg.users.find(function (x) { return (x.upn || '').toLowerCase() === meUpn; });
          var dest = rec && rec.landingPage;
          if (dest && dest !== 'index.html' && dest !== '/' && dest !== here.replace(/^\//, '')) {
            location.replace('/' + dest.replace(/^\//, ''));
            return; // stop bootstrap — the next page will run its own
          }
        }
      }
    } catch (e) { /* never block bootstrap on the redirect */ }

    // Auto-enforce per-app permissions. Pages can call bccEnforcePagePermission
    // again with a stricter minLevel if needed (e.g. admin.html requires 'admin').
    // Skipped when not signed in -- the SWA auth chain still gates the page.
    if (signedIn) {
      try {
        var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
        var appKey = window.BCC_PAGE_TO_APP[here] || 'home';
        // Admin & activity pages require 'admin' to enter
        var minLevel = (appKey === 'admin') ? 'admin' : 'view';
        window.bccEnforcePagePermission(appKey, minLevel);
      } catch (e) { console.warn('[bcc-api] page permission check failed', e); }
    }

    /* Announce the BOOTSTRAP PULL as a data change before anything else.
       The bootstrap writes localStorage with the UN-hooked setter (_origSetItem), so it
       fires no event of its own, and 'bcc-data-ready' is dispatched ONLY by the 8s delta
       poll, and only for docs some other device changed. Pages used to get their post-sync
       repaint by accident: their auth-ready handler re-ran init() unconditionally, so a
       load slower than 600ms rendered twice — once from stale localStorage at the timeout,
       once from server data. Sweep 5 made init() run exactly once (correctly — the second
       run was also re-registering every listener) and that accidental repaint went with it,
       leaving 12 pages showing a pre-sync snapshot for the whole session, and showing
       nothing at all on a device with cold storage.
       Every page already has a correct 'bcc-data-ready' handler, so this restores the
       repaint through the intended channel instead. live:false marks it as the boot pull
       rather than a delta; keys:null means "assume everything changed". Nothing is focused
       or half-typed this early, so no in-progress edit can be clobbered. */
    /* ORDER MATTERS: auth-ready FIRST. Every page's bcc-data-ready handler assumes init()
       has already run — it repaints using module-level element references that init() is
       what assigns. Dispatching data-ready first meant that on any bootstrap faster than the
       600ms fallback the handler ran before init() had ever executed, so those references
       were still undefined and the handler threw ("Cannot set properties of undefined"),
       which the global error boundary showed as "Something went wrong on this page".
       auth-ready runs init() (once, via bootOnce); data-ready then repaints it with the
       freshly pulled data. Both boot paths end up init-then-repaint. */
    window.dispatchEvent(new Event('bcc-auth-ready'));
    window.dispatchEvent(new CustomEvent('bcc-data-ready', { detail: { keys: null, live: false } }));
    if (window.bccPeople) window.dispatchEvent(new Event('bcc-users-ready'));

    // Audit: record sign-in once per browser session. Subsequent page loads
    // during the same session don't re-log (would be noise — one row per
    // tab open is plenty).
    if (signedIn) {
      try {
        if (!sessionStorage.getItem('bcc-audit-signin')) {
          sessionStorage.setItem('bcc-audit-signin', '1');
          window.bccAudit('signin');
        }
      } catch (e) {}

      // Page-view: one row per navigation to a distinct page. Lets the
      // activity log show "Bob viewed /jobs.html at 9:14a" without each
      // page having to wire its own call.
      try {
        var page = location.pathname.split('/').pop() || 'index.html';
        window.bccAudit('page-view', { meta: { page: page } });
      } catch (e) {}
    }
  }

  /* ---------- Unified navigation (single source of truth) ----------
   * Every page's topbar shows the same hamburger menu, listing every
   * destination grouped by audience. Per-page <a class="nav-link"> HTML
   * is hidden via CSS so it stays as dead-code without affecting layout.
   * To add or remove a destination, edit this list — no per-page edits.
   */
  var NAV_GROUPS = [
    { label: 'My workspace', items: [
      { href: 'myday.html',     icon: '📍', name: 'My Day' },
      { href: 'sessions.html',  icon: '🗓', name: 'Sessions' },
      { href: 'dashboard.html', icon: '🎯', name: 'Client Dashboard' },
      { href: 'chat.html',      icon: '💬', name: 'Team Chat' }
    ]},
    { label: 'Revenue', items: [
      { href: 'crm.html',       icon: '👥', name: 'CRM' },
      { href: 'jobs.html',      icon: '📋', name: 'Engagements' },
      { href: 'rates.html',     icon: '💰', name: 'Rate Sheet' },
      { href: 'marketing.html', icon: '📣', name: 'Marketing' }
    ]},
    { label: 'Operations', items: [
      { href: 'scheduler.html', icon: '🗓', name: 'Scheduler' },
      { href: 'bookkeeping.html', icon: '📊', name: 'Bookkeeping' },
      { href: 'documents.html', icon: '📄', name: 'Documents' },
      { href: 'training.html',  icon: '🎓', name: 'Training' },
      { href: 'events.html',    icon: '🎤', name: 'Events' }
    ]},
    { label: 'Admin', items: [
      { href: 'admin.html',     icon: '⚙',  name: 'Admin' },
      { href: 'kb.html',        icon: '📚', name: 'Knowledge Base' },
      { href: 'activity.html',  icon: '🔒', name: 'Activity Log' }
    ]},
    { label: 'Help', items: [
      { href: 'guide.html',     icon: '❔', name: 'How-To Guide' }
    ]}
  ];

  /* ---------- UI ---------- */
  // Capture client-side JS errors + unhandled promise rejections into the server
  // error log (throttled to 1/min per message, only when signed in).
  (function () {
    var lastAt = {};
    function reportClientError(where, message, stack, url) {
      if (!signedIn || !message) return;
      var k = String(message).slice(0, 120), now = Date.now();
      if (lastAt[k] && now - lastAt[k] < 60000) return;
      lastAt[k] = now;
      try { fetch('/api/errorlog', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ where: where, message: String(message).slice(0, 600), stack: String(stack || '').slice(0, 2000), url: url || location.pathname }) }).catch(function () {}); } catch (e) {}
    }
    window.addEventListener('error', function (e) { if (!e) return; reportClientError('window.onerror', e.message || 'script error', (e.error && e.error.stack) || (e.filename ? (e.filename + ':' + e.lineno + ':' + e.colno) : ''), location.pathname); });
    /* Drain the boot buffer. Each page installs a tiny inline listener in <head> that
       records errors into window.__bccErrs, because THIS file is deferred — its listener is
       not installed until the page's own inline script has already parsed and run, which is
       precisely when a boot-time throw happens. Those errors were therefore never reported,
       which is why three separate outages had to be noticed by a person instead. Drained
       once identity is known, since reportClientError needs signedIn to be true. */
    function drainBootErrors() {
      var buf = window.__bccErrs;
      if (!signedIn || !buf || !buf.length) return;
      window.__bccErrs = [];
      buf.forEach(function (b) { reportClientError('boot', b.m, b.s, b.u); });
    }
    window.addEventListener('bcc-auth-ready', drainBootErrors);
    setTimeout(drainBootErrors, 4000);   // belt-and-braces if auth-ready never fires
    window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; reportClientError('unhandledrejection', (r && r.message) || String(r || 'rejection'), (r && r.stack) || '', location.pathname); });
  })();

  // Global feedback modal — openable from the topbar button (or window.bccOpenFeedback()).
  window.bccOpenFeedback = function () {
    if (document.getElementById('bcc-fb-modal')) return;
    var types = [['idea', '💡 Idea'], ['bug', '🐞 Bug'], ['question', '❓ Question'], ['praise', '🎉 Praise'], ['other', '💬 Other']];
    var ov = document.createElement('div');
    ov.id = 'bcc-fb-modal';
    ov.className = 'bcc-modal-overlay open';
    ov.innerHTML = '<div class="bcc-modal-card" role="dialog" aria-modal="true" aria-label="Send feedback">' +
      '<h3>Send feedback</h3>' +
      '<div class="bcc-modal-sub">Tell us what’s working, what’s broken, or what you’d like to see — it goes straight to the BCC team.</div>' +
      '<label>Type</label>' +
      '<div class="bcc-fb-types">' + types.map(function (t, i) { return '<button type="button" class="bcc-fb-chip' + (i === 0 ? ' sel' : '') + '" data-type="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<label>Your feedback <span class="bcc-req">*</span></label>' +
      '<textarea id="bcc-fb-msg" rows="5" placeholder="What happened, or what would help?"></textarea>' +
      '<label>Screenshots or files (optional)</label>' +
      '<div id="bcc-fb-drop" class="bcc-fb-drop">' +
        '<span class="bcc-fb-drop-txt">Paste a screenshot (<strong>Ctrl</strong>+<strong>V</strong>), drag files here, or ' +
        '<button type="button" id="bcc-fb-pick" class="bcc-fb-pick">choose files</button></span>' +
        '<input type="file" id="bcc-fb-file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,application/pdf" multiple hidden />' +
      '</div>' +
      '<div id="bcc-fb-atts" class="bcc-fb-atts"></div>' +
      '<label>How’s your experience? (optional)</label>' +
      '<div class="bcc-fb-stars" id="bcc-fb-stars">' + [1, 2, 3, 4, 5].map(function (n) { return '<span class="bcc-fb-star" data-n="' + n + '" role="button" aria-label="' + n + ' star">★</span>'; }).join('') + '</div>' +
      '<div class="bcc-modal-actions">' +
        '<button type="button" class="bcc-btn-ghost" id="bcc-fb-cancel">Cancel</button>' +
        '<button type="button" class="bcc-btn-primary" id="bcc-fb-send">Send feedback</button>' +
      '</div>' +
      // Somewhere to read the FULL reply to something you sent — the bell only
      // carries a short preview, and the admin view isn't open to everyone.
      '<div style="border-top:1px solid #eee;margin-top:14px;padding-top:10px;">' +
        '<button type="button" id="bcc-fb-minebtn" style="background:none;border:none;padding:0;color:#a8884a;font-weight:700;font-size:12.5px;cursor:pointer;">📋 My past feedback &amp; replies</button>' +
        '<div id="bcc-fb-mine" style="display:none;margin-top:10px;max-height:260px;overflow-y:auto;"></div>' +
      '</div></div>';
    document.body.appendChild(ov);
    var chosenType = 'idea', rating = 0;
    /* ---------- attachments ---------- */
    var FB_MAX_FILES = 5, FB_MAX_BYTES = 10 * 1024 * 1024, FB_SHOT_PX = 1600;
    var atts = [];   // { name, type, blob, url }
    var attsEl = document.getElementById('bcc-fb-atts');
    var dropEl = document.getElementById('bcc-fb-drop');
    function fbBytes(n) { return n < 1024 ? n + ' B' : (n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'); }
    function renderAtts() {
      if (!attsEl) return;
      if (!atts.length) { attsEl.innerHTML = ''; return; }
      attsEl.innerHTML = atts.map(function (a, i) {
        var thumb = /^image\//.test(a.type)
          ? '<img src="' + a.url + '" alt="" />'
          : '<span class="bcc-fb-doc">PDF</span>';
        return '<div class="bcc-fb-att">' + thumb +
          '<span class="bcc-fb-att-n" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
          '<span class="bcc-fb-att-s">' + fbBytes(a.blob.size) + '</span>' +
          '<button type="button" class="bcc-fb-att-x" data-x="' + i + '" aria-label="Remove ' + escapeHtml(a.name) + '">&times;</button></div>';
      }).join('');
      attsEl.querySelectorAll('[data-x]').forEach(function (b) {
        b.onclick = function () {
          var i = +b.getAttribute('data-x');
          try { URL.revokeObjectURL(atts[i].url); } catch (e) {}
          atts.splice(i, 1);
          renderAtts();
        };
      });
    }
    /* Re-encode a screenshot to something a report can actually carry. A Windows Win+Shift+S
       of a 4K monitor is a 6-8 MB PNG; nobody needs that to read a error message, and on a
       bookkeeper's connection it is the difference between "sent" and "still spinning".
       Steps the quality down rather than refusing a busy screenshot that compresses badly. */
    function fbShrink(file, done) {
      if (!/^image\//.test(file.type) || file.type === 'image/gif') { done(file); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} done(file); };   // keep the original rather than lose it
      img.onload = function () {
        try {
          var scale = Math.min(1, FB_SHOT_PX / Math.max(img.width, img.height, 1));
          if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { URL.revokeObjectURL(url); done(file); return; }
          var cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(img.width * scale));
          cv.height = Math.max(1, Math.round(img.height * scale));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          var tries = [0.85, 0.7, 0.55, 0.4], i = 0;
          var next = function () {
            cv.toBlob(function (b) {
              if (!b) { done(file); return; }
              if (b.size <= FB_MAX_BYTES || i >= tries.length - 1) {
                // Name it for what it now is, so the stored type and the extension agree.
                done(new File([b], String(file.name || 'screenshot').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
                return;
              }
              i++; next();
            }, 'image/jpeg', tries[i]);
          };
          next();
        } catch (e) { try { URL.revokeObjectURL(url); } catch (e2) {} done(file); }
      };
      img.src = url;
    }
    var FB_OK_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf)$/;
    function addFiles(list) {
      var arr = Array.prototype.slice.call(list || []);
      if (!arr.length) return;
      var room = FB_MAX_FILES - atts.length;
      if (room <= 0) { (window.bccNotify || alert)('You can attach up to ' + FB_MAX_FILES + ' files.', 'warn', 6000); return; }
      if (arr.length > room) {
        (window.bccNotify || alert)('Only the first ' + room + ' were added — up to ' + FB_MAX_FILES + ' files per report.', 'warn', 7000);
        arr = arr.slice(0, room);
      }
      arr.forEach(function (f) {
        var base = String(f.type || '').split(';')[0].trim().toLowerCase();
        if (!FB_OK_TYPES.test(base)) {
          (window.bccNotify || alert)('“' + (f.name || 'That file') + '” was not added — screenshots (PNG/JPG/GIF/WEBP) and PDFs only.', 'warn', 8000);
          return;
        }
        fbShrink(f, function (out) {
          if (out.size > FB_MAX_BYTES) {
            (window.bccNotify || alert)('“' + (f.name || 'That file') + '” is still ' + fbBytes(out.size) + ' after resizing — the limit is ' + fbBytes(FB_MAX_BYTES) + '.', 'warn', 9000);
            return;
          }
          atts.push({ name: out.name || 'attachment', type: out.type, blob: out, url: URL.createObjectURL(out) });
          renderAtts();
        });
      });
    }
    var pick = document.getElementById('bcc-fb-pick'), fileInp = document.getElementById('bcc-fb-file');
    if (pick && fileInp) pick.onclick = function () { fileInp.click(); };
    if (fileInp) fileInp.onchange = function () { addFiles(fileInp.files); fileInp.value = ''; };
    if (dropEl) {
      ['dragenter', 'dragover'].forEach(function (ev) { dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); }); });
      dropEl.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
    }
    /* PASTE, on the whole dialog. Win+Shift+S puts the screenshot on the clipboard and never
       on disk, so this is the way these files actually arrive — requiring the caret to be in
       a particular box would have made the feature unusable for exactly the person it is for. */
    var onPaste = function (e) {
      if (!document.getElementById('bcc-fb-modal')) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var picked = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        var f = items[i].getAsFile();
        if (f) picked.push(f);
      }
      if (!picked.length) return;   // plain text paste — leave it to the textarea
      e.preventDefault();
      addFiles(picked);
    };
    document.addEventListener('paste', onPaste);
    ov.querySelectorAll('.bcc-fb-chip').forEach(function (b) { b.onclick = function () { ov.querySelectorAll('.bcc-fb-chip').forEach(function (x) { x.classList.remove('sel'); }); b.classList.add('sel'); chosenType = b.getAttribute('data-type'); }; });
    ov.querySelectorAll('.bcc-fb-star').forEach(function (s) { s.onclick = function () { rating = +s.getAttribute('data-n'); ov.querySelectorAll('.bcc-fb-star').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-n') <= rating); }); }; });
    function close() {
      var m = document.getElementById('bcc-fb-modal'); if (m) m.remove();
      document.removeEventListener('keydown', onKey);
      // Release the previews and stop listening for pastes into a dialog that is gone.
      document.removeEventListener('paste', onPaste);
      atts.forEach(function (a) { try { URL.revokeObjectURL(a.url); } catch (e) {} });
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.getElementById('bcc-fb-cancel').onclick = close;
    document.getElementById('bcc-fb-send').onclick = function () {
      var msg = (document.getElementById('bcc-fb-msg').value || '').trim();
      if (!msg) { (window.bccNotify || alert)('Please write your feedback first.', 'warn'); return; }
      var btn = document.getElementById('bcc-fb-send'); btn.disabled = true; btn.textContent = 'Sending…';
      var payload = JSON.stringify({ type: chosenType, message: msg, rating: rating || null, page: location.pathname });
      // Submit with one automatic retry on a transient failure (network blip /
      // 5xx), so a momentary hiccup doesn't look like "feedback is broken".
      // The typed text is NEVER cleared unless the send actually succeeds.
      function attempt(triesLeft) {
        return fetch('/api/feedback', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: payload })
          .then(function (r) {
            if (r.ok) return r.json();
            // 4xx = won't fix on retry; 5xx / network = retry once.
            if (r.status >= 500 && triesLeft > 0) return new Promise(function (res) { setTimeout(res, 900); }).then(function () { return attempt(triesLeft - 1); });
            return Promise.reject(new Error('HTTP ' + r.status));
          })
          .catch(function (err) {
            // fetch() rejects (offline / DNS / CORS) → retry once before giving up.
            if (triesLeft > 0 && /Failed to fetch|NetworkError|load failed/i.test(String(err && err.message))) {
              return new Promise(function (res) { setTimeout(res, 900); }).then(function () { return attempt(triesLeft - 1); });
            }
            throw err;
          });
      }
      attempt(1)
        .then(function (j) {
          var id = j && j.id;
          if (!atts.length || !id) {
            close();
            if (window.bccNotifySaved) window.bccNotifySaved('Thanks! Your feedback was sent.');
            else (window.bccNotify || alert)('Thanks! Feedback sent.', 'success');
            return;
          }
          btn.textContent = 'Sending ' + atts.length + ' file' + (atts.length === 1 ? '' : 's') + '…';
          var fd = new FormData();
          atts.forEach(function (a) { fd.append('file', a.blob, a.name); });
          return fetch('/api/feedback/' + encodeURIComponent(id) + '/attach', { method: 'POST', credentials: 'include', body: fd })
            .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
            .then(function (aj) {
              close();
              var refused = (aj && aj.refused) || [];
              /* The report is SAVED either way — say precisely which half happened rather
                 than a blanket success or a blanket failure over words that are already in. */
              if (!aj || aj.ok === false) {
                (window.bccNotify || alert)('Your feedback was sent, but the ' + (atts.length === 1 ? 'file' : 'files') + ' could not be attached. Reply to the confirmation, or send them again from the feedback box.', 'warn', 12000);
                return;
              }
              if (refused.length) {
                (window.bccNotify || alert)('Feedback sent with ' + (aj.attached || 0) + ' of ' + atts.length + ' file' + (atts.length === 1 ? '' : 's') + '. ' + refused.map(function (x) { return (x.name || 'a file') + ' — ' + x.why; }).join('; ') + '.', 'warn', 13000);
                return;
              }
              if (window.bccNotifySaved) window.bccNotifySaved('Thanks! Your feedback was sent with ' + (aj.attached || 0) + ' file' + ((aj.attached || 0) === 1 ? '' : 's') + '.');
              else (window.bccNotify || alert)('Thanks! Feedback sent.', 'success');
            })
            .catch(function () {
              close();
              (window.bccNotify || alert)('Your feedback was sent, but the ' + (atts.length === 1 ? 'file' : 'files') + ' could not be uploaded — check your connection and send them in a follow-up.', 'warn', 12000);
            });
        })
        .catch(function (err) {
          btn.disabled = false; btn.textContent = 'Send feedback';
          // Keep the user's text in place so they never retype; give a real reason.
          (window.bccNotify || alert)('Could not send your feedback (' + (String(err && err.message || 'network error')) + '). Your text is still here — please try again in a moment.', 'warn', 8000);
        });
    };
    // "My past feedback" — load on first open, render each submission with its full reply.
    var mineLoaded = false;
    document.getElementById('bcc-fb-minebtn').onclick = function () {
      var box = document.getElementById('bcc-fb-mine');
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      box.style.display = 'block';
      if (mineLoaded) return;
      mineLoaded = true;
      box.innerHTML = '<div style="color:#6b7077;font-size:12.5px;">Loading…</div>';
      fetch('/api/feedback-mine', { credentials: 'include' })
        // An HTTP failure is not an empty history — the honest .catch below already says so,
        // and collapsing to null routed every error past it into the empty state instead.
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          var items = (j && j.items) || [];
          if (!items.length) { box.innerHTML = '<div style="color:#6b7077;font-size:12.5px;">You haven’t sent any feedback yet.</div>'; return; }
          var LBL = { idea: '💡 Idea', bug: '🐞 Bug', question: '❓ Question', praise: '🎉 Praise', other: '💬 Other' };
          box.innerHTML = items.map(function (f) {
            var when = '';
            try { when = new Date(f.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (e) {}
            var st = f.status === 'resolved' ? '<span style="color:#1f8a4c;font-weight:700;">✓ answered</span>'
                   : f.status === 'reviewed' ? '<span style="color:#8a6f3c;font-weight:700;">seen</span>'
                   : '<span style="color:#6b7077;">waiting</span>';
            return '<div style="border:1px solid #eee;border-radius:8px;padding:9px 11px;margin-bottom:8px;">' +
              '<div style="font-size:11px;color:#6b7077;display:flex;gap:8px;align-items:center;">' + (LBL[f.type] || '💬') + ' · ' + escapeHtml(when) + ' · ' + st + '</div>' +
              '<div style="font-size:13px;color:#1a1a1a;margin-top:4px;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(f.message || '') + '</div>' +
              /* What they attached, readable back. Without this the pictures went into a
                 black box: the sender had no way to confirm the screenshot actually made it,
                 which is precisely the doubt this whole feature exists to remove. */
              (((f.attachments || []).length)
                ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;">' + f.attachments.map(function (a) {
                    var href = '/api/feedback/' + encodeURIComponent(f.id) + '/attachment/' + encodeURIComponent(a.id) + '?inline=1';
                    return /^image\//.test(a.mimeType || '')
                      ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener" title="' + escapeHtml(a.name || '') + '"><img src="' + escapeHtml(href) + '" alt="' + escapeHtml(a.name || 'attachment') + '" style="width:56px;height:56px;object-fit:cover;border:1px solid #e6e5e1;border-radius:6px;display:block;" /></a>'
                      : '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener" style="font-size:12px;color:#a8884a;font-weight:700;border:1px solid #e6e5e1;border-radius:6px;padding:6px 8px;text-decoration:none;">📄 ' + escapeHtml(a.name || 'file') + '</a>';
                  }).join('') + '</div>'
                : '') +
              (f.resolutionNote
                ? '<div style="background:#e9f5ec;border:1px solid #cfe7d6;border-radius:7px;padding:8px 10px;margin-top:8px;">' +
                  '<div style="font-size:11px;font-weight:800;color:#1f8a4c;text-transform:uppercase;letter-spacing:.6px;">Reply</div>' +
                  '<div style="font-size:13px;color:#1a1a1a;margin-top:3px;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(f.resolutionNote) + '</div></div>'
                : '') +
              '</div>';
          }).join('');
        })
        .catch(function () { box.innerHTML = '<div style="color:#7a1f2b;font-size:12.5px;">Could not load your feedback.</div>'; });
    };
    setTimeout(function () { var m = document.getElementById('bcc-fb-msg'); if (m) m.focus(); }, 50);
  };

  /* Bring chrome that is ALREADY on the page into line with a later auth verdict.
     Deliberately narrow: the chip, the Feedback button, and the drawer's identity line and
     footer — the parts that state who you are and what you can do about it. The drawer's
     link list is left as it is; it rebuilds on the next navigation, and hiding a link out
     from under a finger mid-tap is worse than one that refuses politely. The drawer's click
     handling is delegated on the drawer itself, so replacing these anchors keeps working. */
  function repaintAuthChrome(chip) {
    chip.className = 'bcc-auth-chip ' + (signedIn ? 'auth' : 'anon');
    if (signedIn) {
      var email = (user && user.userDetails) || 'Signed in';
      var nm = window.bccDisplayName(email) || email;
      chip.innerHTML =
        '<span class="bcc-dot" title="Cloud sync active"></span>' +
        '<span class="bcc-name" title="' + escapeHtml(email) + '">' + escapeHtml(nm) + '</span>' +
        '<a href="#" id="bcc-out">Sign out</a>';
    } else {
      chip.innerHTML =
        '<span class="bcc-dot" title="Local-only (not signed in)"></span>' +
        '<a href="#" id="bcc-in">Sign in</a>';
    }
    var inEl2 = document.getElementById('bcc-in'), outEl2 = document.getElementById('bcc-out');
    if (inEl2)  inEl2.onclick  = function (e) { e.preventDefault(); bccSignIn(); };
    if (outEl2) outEl2.onclick = function (e) { e.preventDefault(); bccSignOut(); };
    if (signedIn) {
      if (!document.getElementById('bcc-fb-btn') && chip.parentNode) {
        var fb2 = document.createElement('button');
        fb2.id = 'bcc-fb-btn'; fb2.className = 'bcc-fb-btn'; fb2.type = 'button'; fb2.title = 'Send feedback';
        fb2.innerHTML = '<span class="bcc-fb-ic">💬</span><span class="bcc-fb-lbl">Feedback</span>';
        fb2.onclick = function () { window.bccOpenFeedback(); };
        chip.parentNode.insertBefore(fb2, chip);
      }
    } else {
      var fbOld = document.getElementById('bcc-fb-btn');
      if (fbOld && fbOld.parentNode) fbOld.parentNode.removeChild(fbOld);
    }
    var whoEl = document.querySelector('.bcc-mobile-menu .bcc-mm-user > div');
    if (whoEl) {
      var e2 = signedIn ? ((user && user.userDetails) || '') : '';
      var dn2 = signedIn ? (window.bccDisplayName(e2) || e2 || 'User') : '';
      whoEl.innerHTML = signedIn
        ? 'Signed in as<strong>' + escapeHtml(dn2) + '</strong>' +
          (e2 && e2 !== dn2
            ? '<span style="display:block;font-size:11px;color:rgba(255,255,255,0.55);font-weight:500;margin-top:2px;">' + escapeHtml(e2) + '</span>'
            : '')
        : '<strong>Not signed in</strong>';
    }
    var footEl = document.querySelector('.bcc-mobile-menu .bcc-mm-foot');
    if (footEl) {
      footEl.innerHTML = signedIn
        ? '<a href="#" class="bcc-mm-feedback">💬 Send feedback</a><a href="#" class="bcc-mm-signout">Sign out</a>'
        : '<a href="#" class="bcc-mm-signin">Sign in with Microsoft</a>';
    }
  }

  function injectAuthChip() {
    /* Re-entrant on purpose. bootstrap() runs more than once: a device that got NO verdict
       from /.auth/me — offline, or the SWA edge unreachable — paints the anonymous chrome,
       and retryAuthBootstrap re-runs the whole bootstrap the moment focus or the network
       returns. Bailing out because the element existed left a fully signed-in, syncing user
       looking at a grey dot, a "Sign in" link, no Feedback button, and a drawer that read
       "Not signed in" — with a reload as the only way out. */
    var existingChip = document.getElementById('bcc-auth-chip');
    if (existingChip) {
      if (existingChip.classList.contains(signedIn ? 'auth' : 'anon')) return;  // verdict unchanged
      repaintAuthChrome(existingChip);
      return;
    }
    if (!document.head) return;

    var css = document.createElement('style');
    css.textContent =
      // ---- Skip-to-content link (a11y) ----
      // Invisible until focused; first tab-stop on every page so keyboard
      // users can jump past the topbar/nav.
      '.bcc-skip{position:absolute;left:-9999px;top:0;background:#a8884a;color:#fff;padding:10px 16px;font-weight:700;text-decoration:none;border-radius:0 0 8px 0;z-index:10000;}' +
      '.bcc-skip:focus{left:0;outline:2px solid #fff;outline-offset:-4px;}' +
      // ---- Toasts (window.bccNotify) ----
      // Non-blocking notifications. Slide in from the bottom on mobile, top-
      // right on desktop. Auto-dismiss after 3-5 s, or click the × to dismiss.
      '.bcc-toast-wrap{position:fixed;z-index:9998;display:flex;flex-direction:column;gap:8px;pointer-events:none;}' +
      '@media (max-width:600px){.bcc-toast-wrap{left:10px;right:10px;bottom:14px;}}' +
      '@media (min-width:601px){.bcc-toast-wrap{top:14px;right:14px;max-width:380px;}}' +
      '.bcc-toast{pointer-events:auto;background:#1a1a1a;color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,0.30);font-size:13.5px;font-weight:600;display:flex;align-items:flex-start;gap:10px;line-height:1.4;transform:translateY(20px);opacity:0;transition:transform 0.22s, opacity 0.22s;}' +
      '.bcc-toast.show{transform:translateY(0);opacity:1;}' +
      '.bcc-toast .ic{font-size:18px;line-height:1;flex-shrink:0;}' +
      '.bcc-toast.success{background:#15803d;}' +
      '.bcc-toast.error{background:#6a1c1c;}' +
      '.bcc-toast.warn{background:#a16207;}' +
      '.bcc-toast .x{background:transparent;border:none;color:rgba(255,255,255,0.8);font-size:16px;line-height:1;cursor:pointer;padding:0;margin-left:auto;}' +
      '.bcc-toast .x:hover{color:#fff;}' +
      // ---- Offline banner ----
      '.bcc-offline{position:fixed;top:0;left:0;right:0;z-index:60;background:#a16207;color:#fff;padding:8px 14px;font-size:13px;font-weight:700;text-align:center;display:none;}' +
      '.bcc-offline.show{display:block;}' +
      /* The refused-changes bar sits just under the offline one when both are up, and carries
         its own action button — the one control the person needs and the only way back to
         work the server would not take. */
      '.bcc-fb-drop{border:1.5px dashed var(--chrome-mute,#d9d7d1);border-radius:9px;padding:12px;text-align:center;font-size:12.5px;color:#6b7077;background:#fbfaf7;}' +
      '.bcc-fb-drop.over{border-color:#a8884a;background:#f7f1e4;color:#5a4a24;}' +
      '.bcc-fb-pick{background:none;border:0;padding:0;color:#a8884a;font:inherit;font-weight:700;cursor:pointer;text-decoration:underline;}' +
      '.bcc-fb-atts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}' +
      '.bcc-fb-att{display:flex;align-items:center;gap:6px;border:1px solid var(--chrome-mute,#e6e5e1);border-radius:8px;padding:5px 7px;background:#fff;max-width:100%;}' +
      '.bcc-fb-att img{width:38px;height:38px;object-fit:cover;border-radius:5px;display:block;}' +
      '.bcc-fb-doc{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:5px;background:#f1efe9;font-size:10px;font-weight:800;color:#6b7077;}' +
      '.bcc-fb-att-n{font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.bcc-fb-att-s{font-size:11px;color:#6b7077;}' +
      '.bcc-fb-att-x{background:none;border:0;font-size:17px;line-height:1;color:#6b7077;cursor:pointer;padding:0 2px;min-height:24px;}' +
      '.bcc-refused{background:#7f1d1d;z-index:59;}' +
      '.bcc-incomplete{background:#92400e;z-index:58;}' +
      '.bcc-incomplete .bcc-incomplete-go{margin-left:10px;background:#fff;color:#92400e;border:0;border-radius:6px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;min-height:28px;}' +
      '.bcc-refused .bcc-refused-go{margin-left:10px;background:#fff;color:#7f1d1d;border:0;border-radius:6px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;min-height:28px;}' +
      '.bcc-refused .bcc-refused-go[disabled]{opacity:.6;cursor:default;}' +
      // ---- Global hardening ----
      // Stop accidental horizontal scroll on phones (a single too-wide
      // image or table can drag the whole page sideways).
      'html, body{overflow-x:hidden;max-width:100%;}' +
      // Force images / videos / iframes never to overflow their container.
      // Photo grids on daily logs / jobs board are the most common offenders.
      'img, video, iframe{max-width:100%; height:auto;}' +
      // Smooth scrolling for in-page anchor links (guide.html TOC etc.) —
      // respects prefers-reduced-motion automatically.
      'html{scroll-behavior:smooth;}' +
      '@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto;}}' +
      // Visible keyboard focus ring everywhere — essential for accessibility
      // and helps the keyboard-power-users (office staff). Excluded on
      // mouse-click (uses :focus-visible).
      'button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible{outline:2px solid #a8884a; outline-offset:2px;}' +
      // ---- Touch-target minimums (mobile / tablet only) ----
      // On coarse-pointer devices, bump every form control & button to a
      // 44 px minimum tap height per Apple HIG / WCAG 2.2 target-size. Only
      // enlarges; never shrinks. Excludes bcc-* internal chrome that already
      // sizes itself and excludes inline chips that are decorative.
      '@media (pointer: coarse){' +
        'button, .btn, [role="button"], input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea{min-height:44px;}' +
        'a.nav-link, a.stile, .bcc-mm-link, .tabs-bar .tab, .toolbar .tab{min-height:44px;}' +
      '}' +
      // Light-topbar auth chip: dark text on a subtle gold-tinted pill.
      '.bcc-auth-chip{display:inline-flex;align-items:center;gap:6px;color:#6b7077;font-size:12.5px;font-weight:600;padding:5px 11px;border-radius:999px;background:#f6f6f4;border:1px solid #e6e5e1;}' +
      '.bcc-auth-chip .bcc-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0;}' +
      '.bcc-auth-chip.anon .bcc-dot{background:#b9b5ab;}' +
      '.bcc-auth-chip.syncing .bcc-dot{background:#c5a55a;animation:bccPulse 1s infinite;}' +
      '.bcc-auth-chip.error .bcc-dot{background:#b4524f;}' +
      '@keyframes bccPulse{0%{opacity:0.4;}50%{opacity:1;}100%{opacity:0.4;}}' +
      '.bcc-auth-chip .bcc-name{color:#23262b;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.bcc-auth-chip a{color:#a8884a;text-decoration:none;font-size:12px;font-weight:700;white-space:nowrap;}' +
      '.bcc-auth-chip a:hover{color:#8a6f3c;text-decoration:underline;}' +
      // Single unified menu pattern — same on every viewport. Per-page inline
      // <a class="nav-link"> elements are hidden so the topbar stays clean.
      'header.topbar{position:relative;flex-wrap:nowrap;}' +
      'header.topbar > a.nav-link{display:none !important;}' +
      /* Phone breakpoint. flex-wrap:nowrap above means the topbar cannot wrap, so on a narrow
         screen the row's min-content width simply overflows and the LAST child — the
         hamburger — is pushed off the right edge. That hamburger is the only navigation and
         the only way to sign out on a phone, so on most pages a phone user was stranded on
         whatever page they landed on. Dropping the module/product/wordmark labels reclaims
         115-198px, which brings even the widest page inside a 320px viewport. This belongs
         here rather than in a page stylesheet because it affects 17 of the 18 pages. */
      '@media (max-width:700px){' +
        'header.topbar{gap:8px;padding-left:12px;padding-right:12px;}' +
        'header.topbar .module,header.topbar .product,header.topbar .wordmark{display:none;}' +
        'header.topbar a.home,header.topbar .bcc-auth-chip{min-width:0;flex-shrink:1;}' +
        '.bcc-auth-chip .bcc-name{max-width:88px;}' +
        '#bcc-hamburger{margin-left:auto;flex:0 0 auto;}' +
      '}' +
      // ---- Global LIGHT topbar (brand concept) ----
      // Every page body is already light (#f6f6f4/#fff); only the topbar was
      // dark. Force it light app-wide here so the chrome matches the home page
      // and bcc-brand.css without editing 18 per-page stylesheets.
      'header.topbar{background:rgba(255,255,255,0.96) !important;backdrop-filter:saturate(160%) blur(8px);border-bottom:1px solid #e6e5e1 !important;color:#23262b !important;}' +
      'header.topbar a.home,header.topbar .home{color:#1a1a1a !important;}' +
      'header.topbar .wordmark{color:#1a1a1a !important;}' +
      'header.topbar .wordmark .light{color:#a8884a !important;}' +
      'header.topbar .module,header.topbar .product{color:#6b7077 !important;border-left-color:#e6e5e1 !important;}' +
      // Module pages used a dark logo on dark bar; on the light bar drop any
      // white-pill padding the logo had so it sits cleanly.
      'header.topbar img{background:transparent !important;}' +
      // Hamburger button — always visible, lives on the right side of topbar.
      '.bcc-hamburger{display:inline-flex;align-items:center;justify-content:center;background:#f6f6f4;border:1px solid #e6e5e1;color:#1a1a1a;width:40px;height:40px;border-radius:9px;cursor:pointer;font-size:20px;flex-shrink:0;padding:0;line-height:1;transition:background 0.15s,border-color 0.15s;}' +
      '.bcc-hamburger:hover{background:#f7f1e3;border-color:#c5a55a;}' +
      '.bcc-hamburger.open{background:#f7f1e3;border-color:#c5a55a;}' +
      // Menu drawer (slides from the right; full-height on mobile, panel on desktop)
      '.bcc-mobile-menu{display:none;position:fixed;top:0;right:0;bottom:0;width:320px;max-width:88vw;background:#fff;box-shadow:-12px 0 40px rgba(15,23,42,0.20);z-index:99;overflow-y:auto;padding:0;transform:translateX(100%);transition:transform 0.22s ease;}' +
      '.bcc-mobile-menu.open{display:block;transform:translateX(0);}' +
      '.bcc-mm-backdrop{display:none;position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:98;}' +
      '.bcc-mm-backdrop.open{display:block;}' +
      '.bcc-mobile-menu .bcc-mm-user{padding:18px 22px;background:linear-gradient(135deg,#1a1a1a,#2b2b2b);color:rgba(255,255,255,0.8);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;justify-content:space-between;}' +
      '.bcc-mobile-menu .bcc-mm-user strong{color:#fff;display:block;font-size:14px;font-weight:700;text-transform:none;letter-spacing:0;margin-top:2px;}' +
      '.bcc-mobile-menu .bcc-mm-close{background:rgba(255,255,255,0.12);color:#fff;border:none;width:32px;height:32px;border-radius:7px;cursor:pointer;font-size:18px;line-height:1;flex-shrink:0;}' +
      '.bcc-mobile-menu .bcc-mm-close:hover{background:rgba(255,255,255,0.22);}' +
      '.bcc-mobile-menu .bcc-mm-group{padding:10px 0;border-bottom:1px solid #f6f6f4;}' +
      '.bcc-mobile-menu .bcc-mm-group:last-of-type{border-bottom:none;}' +
      '.bcc-mobile-menu .bcc-mm-grouplabel{padding:10px 22px 4px;font-size:10.5px;font-weight:700;color:#8a877e;letter-spacing:1.5px;text-transform:uppercase;}' +
      '.bcc-mobile-menu a.bcc-mm-link{display:flex;align-items:center;gap:12px;padding:11px 22px;color:#1a1a1a;text-decoration:none;font-size:14.5px;font-weight:600;}' +
      '.bcc-mobile-menu a.bcc-mm-link .bcc-mm-ic{width:22px;text-align:center;font-size:16px;opacity:0.85;}' +
      '.bcc-mobile-menu a.bcc-mm-link:hover,.bcc-mobile-menu a.bcc-mm-link:active{background:#faf4e8;color:#a8884a;}' +
      '.bcc-mobile-menu a.bcc-mm-link.bcc-mm-current{background:#faf4e8;color:#a8884a;border-left:3px solid #a8884a;padding-left:19px;}' +
      '.bcc-mobile-menu a.bcc-mm-link.bcc-mm-current .bcc-mm-ic{opacity:1;}' +
      '.bcc-mobile-menu .bcc-mm-foot{padding:14px 22px;background:#f8fafc;border-top:1px solid #e2e1dd;}' +
      '.bcc-mobile-menu .bcc-mm-foot a{display:block;padding:10px 0;font-size:14px;font-weight:700;color:#a8884a;text-decoration:none;}' +
      '.bcc-mobile-menu .bcc-mm-foot a.bcc-mm-signin{color:#1a1a1a;}' +
      // Compact auth chip — Sign out link is visible on desktop, hidden on
      // phone-sized viewports (where it lives in the hamburger drawer instead).
      'header.topbar .bcc-auth-chip{padding:5px 10px;gap:6px;}' +
      '@media (max-width:520px){' +
        'header.topbar .bcc-auth-chip .bcc-name{max-width:90px;font-size:11px;}' +
        'header.topbar .bcc-auth-chip a{display:none;}' +
      '}' +
      // New-job modal (shared by tm, scheduler, jobs, trucking, myday)
      '.bcc-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);display:none;align-items:center;justify-content:center;z-index:200;padding:20px;}' +
      '.bcc-modal-overlay.open{display:flex;}' +
      '.bcc-modal-card{background:#fff;border-radius:14px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 50px rgba(15,23,42,0.25);font-family:inherit;color:#1a1a1a;}' +
      '.bcc-modal-card h3{color:#2b2b2b;font-size:20px;margin-bottom:4px;font-weight:800;}' +
      '.bcc-modal-card .bcc-modal-sub{color:#6b685f;font-size:12.5px;margin-bottom:16px;}' +
      '.bcc-modal-card label{display:block;font-size:11px;font-weight:700;color:#6b685f;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:5px;margin-top:10px;}' +
      '.bcc-modal-card .bcc-req{color:#7a4848;}' +
      '.bcc-modal-card input,.bcc-modal-card select,.bcc-modal-card textarea{width:100%;padding:10px 12px;border:1px solid #e2e1dd;border-radius:8px;font-family:inherit;font-size:14px;background:#fff;color:#1a1a1a;}' +
      '.bcc-modal-card input:focus,.bcc-modal-card select:focus,.bcc-modal-card textarea:focus{outline:none;border-color:#a8884a;box-shadow:0 0 0 3px rgba(168,136,74,0.12);}' +
      '.bcc-modal-card textarea{resize:vertical;min-height:60px;}' +
      '.bcc-modal-card .bcc-row-2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}' +
      '@media (max-width:520px){.bcc-modal-card .bcc-row-2{grid-template-columns:1fr;}}' +
      '.bcc-modal-actions{display:flex;gap:8px;margin-top:18px;justify-content:flex-end;}' +
      '.bcc-modal-actions button{padding:10px 18px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:13.5px;font-family:inherit;}' +
      '.bcc-btn-primary{background:#a8884a;color:#fff;box-shadow:0 2px 8px rgba(168,136,74,0.30);}' +
      '.bcc-btn-primary:hover{background:#876d3a;}' +
      '.bcc-btn-ghost{background:#f6f6f4;color:#1a1a1a;border:1px solid #e2e1dd;}' +
      '.bcc-btn-ghost:hover{background:#e2e1dd;}' +
      // Feedback button (topbar) + feedback modal bits.
      '.bcc-fb-btn{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #e6e5e1;color:#6b7077;font-family:inherit;font-size:12.5px;font-weight:700;padding:6px 12px;border-radius:999px;cursor:pointer;flex-shrink:0;transition:background .15s,border-color .15s,color .15s;}' +
      '.bcc-fb-btn:hover{background:#faf4e8;border-color:#c5a55a;color:#8a6f3c;}' +
      '.bcc-fb-btn .bcc-fb-ic{font-size:14px;line-height:1;}' +
      '@media (max-width:640px){.bcc-fb-btn .bcc-fb-lbl{display:none;}.bcc-fb-btn{padding:6px 9px;}}' +
      '.bcc-fb-types{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;}' +
      '.bcc-fb-chip{background:#f6f6f4;border:1px solid #e2e1dd;color:#4b4b4b;font-family:inherit;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;cursor:pointer;}' +
      '.bcc-fb-chip:hover{border-color:#c5a55a;}' +
      '.bcc-fb-chip.sel{background:#a8884a;border-color:#a8884a;color:#fff;}' +
      '.bcc-fb-stars{display:flex;gap:4px;font-size:24px;color:#d8d5cc;}' +
      '.bcc-fb-star{cursor:pointer;transition:color .1s;}' +
      '.bcc-fb-star:hover,.bcc-fb-star.on{color:#e0a92e;}' +
      // Generic "+ New job" button alongside a job dropdown
      '.bcc-new-job-row{display:flex;gap:8px;align-items:stretch;min-width:0;max-width:100%;box-sizing:border-box;}' +
      '.bcc-new-job-row select{flex:1 1 0;min-width:0;width:0;}' +
      '.bcc-new-job-btn{background:#a8884a;color:#fff;border:none;padding:0 12px;min-height:38px;border-radius:7px;cursor:pointer;font-weight:700;font-size:13px;white-space:nowrap;font-family:inherit;flex-shrink:0;box-sizing:border-box;}' +
      '.bcc-new-job-btn:hover{background:#876d3a;}' +
      // Grid-cell shrinking fix: by default grid items have min-width:auto,
      // meaning their intrinsic content width keeps them from shrinking past
      // it. A wide .bcc-new-job-row (select + button) inside a `.field` inside
      // a 1fr/1fr grid would refuse to shrink and push past the form card.
      '.form .grid > .field,.form .field{min-width:0;}' +
      // Location chip rendered after every submission. Lives globally so each
      // page doesn't have to re-declare it.
      '.loc-chip{display:inline-flex;align-items:center;background:#e0e7ff;color:#3730a3;padding:2px 7px;border-radius:5px;font-size:11px;font-weight:700;text-decoration:none;line-height:1.4;}' +
      '.loc-chip:hover{background:#c7d2fe;}';
    document.head.appendChild(css);

    // Inject skip-to-content link as the first body child. Keyboard users
    // tab once and can jump past the topbar straight to the page content.
    // Targets the first <main>, .wrap, or .app element on the page.
    if (document.body && !document.getElementById('bcc-skip')) {
      /* Try each selector IN ORDER. A comma list returns the first match in DOCUMENT
         order, not the first selector's match — so adding '.page' to one list would make
         guide.html jump to its in-page sidebar (which wraps the content) instead of the
         content. Several pages have no main/.wrap/.app at all and their container is
         '.page', which is why the link was a dead anchor on kb.html and scheduler.html. */
      var skipTarget = null;
      ['main', '.wrap', '.app', '.board', '.grid-wrap', '.content', '.page'].some(function (sel) {
        skipTarget = document.querySelector(sel);
        return !!skipTarget;
      });
      if (skipTarget && !skipTarget.id) skipTarget.id = 'bcc-main';
      var skip = document.createElement('a');
      skip.id = 'bcc-skip';
      skip.className = 'bcc-skip';
      skip.href = '#' + (skipTarget ? skipTarget.id : 'bcc-main');
      skip.textContent = 'Skip to content';
      document.body.insertBefore(skip, document.body.firstChild);
    }

    var topbar = document.querySelector('header.topbar');
    if (!topbar) return;
    var chip = document.createElement('div');
    chip.id = 'bcc-auth-chip';
    chip.className = 'bcc-auth-chip ' + (signedIn ? 'auth' : 'anon');
    if (signedIn) {
      var emailForTitle = user.userDetails || 'Signed in';
      // Prefer display name; fall back to email if bccPeopleFull isn't loaded
      // yet (a bcc-users-ready listener below upgrades the chip when it lands).
      var nameForChip = window.bccDisplayName(emailForTitle) || emailForTitle;
      chip.innerHTML =
        '<span class="bcc-dot" title="Cloud sync active"></span>' +
        '<span class="bcc-name" title="' + escapeHtml(emailForTitle) + '">' + escapeHtml(nameForChip) + '</span>' +
        '<a href="#" id="bcc-out">Sign out</a>';
    } else {
      chip.innerHTML =
        '<span class="bcc-dot" title="Local-only (not signed in)"></span>' +
        '<a href="#" id="bcc-in">Sign in</a>';
    }
    var spacer = topbar.querySelector('.spacer');
    if (spacer) spacer.parentNode.insertBefore(chip, spacer.nextSibling);
    else topbar.appendChild(chip);

    // Persistent Feedback button — sits just before the auth chip on every page.
    if (signedIn && !document.getElementById('bcc-fb-btn')) {
      var fbBtn = document.createElement('button');
      fbBtn.id = 'bcc-fb-btn';
      fbBtn.className = 'bcc-fb-btn';
      fbBtn.type = 'button';
      fbBtn.title = 'Send feedback';
      fbBtn.innerHTML = '<span class="bcc-fb-ic">💬</span><span class="bcc-fb-lbl">Feedback</span>';
      fbBtn.onclick = function () { window.bccOpenFeedback(); };
      chip.parentNode.insertBefore(fbBtn, chip);
    }

    var inEl  = document.getElementById('bcc-in');
    var outEl = document.getElementById('bcc-out');
    if (inEl)  inEl.onclick  = function (e) { e.preventDefault(); bccSignIn(); };
    if (outEl) outEl.onclick = function (e) { e.preventDefault(); bccSignOut(); };

    // Upgrade the chip + drawer to the display name once bccPeopleFull
    // arrives (bcc-users-ready event). At first paint we may have only
    // the UPN/email; when Entra returns the user list we can switch
    // the chip to "Lewis Koljonen" and drop the email below it.
    window.addEventListener('bcc-users-ready', function () {
      if (!signedIn) return;
      var emailRaw = (user && user.userDetails) || '';
      var dn = window.bccDisplayName(emailRaw) || emailRaw;
      var chipName = document.querySelector('#bcc-auth-chip .bcc-name');
      if (chipName && dn) chipName.textContent = dn;
      // Drawer "Signed in as ..." line, if present
      var drawerStrong = document.querySelector('.bcc-mobile-menu .bcc-mm-user strong');
      if (drawerStrong && dn) drawerStrong.textContent = dn;
    });

    // ---- Universal hamburger + slide-in drawer ----
    if (!document.getElementById('bcc-hamburger')) {
      var hamb = document.createElement('button');
      hamb.id = 'bcc-hamburger';
      hamb.className = 'bcc-hamburger';
      hamb.setAttribute('aria-label', 'Open menu');
      hamb.setAttribute('aria-expanded', 'false');
      hamb.innerHTML = '&#9776;';
      topbar.appendChild(hamb);

      // Backdrop dimmer (sits below drawer, above page)
      var backdrop = document.createElement('div');
      backdrop.className = 'bcc-mm-backdrop';
      document.body.appendChild(backdrop);

      var drawer = document.createElement('nav');
      drawer.id = 'bcc-mobile-menu';
      drawer.className = 'bcc-mobile-menu';
      drawer.setAttribute('aria-label', 'Site navigation');

      // Header: signed-in identity + close. Show the display name as the
      // headline and the email beneath (small) so you can still spot which
      // account is active when multiple Microsoft accounts share a device.
      var emailRaw = signedIn ? (user.userDetails || '') : '';
      var displayName = signedIn ? (window.bccDisplayName(emailRaw) || emailRaw || 'User') : '';
      var whoLine = signedIn
        ? 'Signed in as<strong>' + escapeHtml(displayName) + '</strong>' +
          (emailRaw && emailRaw !== displayName
            ? '<span style="display:block;font-size:11px;color:rgba(255,255,255,0.55);font-weight:500;margin-top:2px;">' + escapeHtml(emailRaw) + '</span>'
            : '')
        : '<strong>Not signed in</strong>';
      var html = '<div class="bcc-mm-user"><div>' + whoLine + '</div>' +
                 '<button class="bcc-mm-close" aria-label="Close menu">&times;</button></div>';

      // Grouped link list — same on every page, but filtered by per-app
      // permission. If the signed-in user has 'none' on a page, the link is
      // hidden entirely so they don't see destinations they can't open.
      var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      NAV_GROUPS.forEach(function (grp) {
        var visibleItems = grp.items.filter(function (it) {
          var key = window.BCC_PAGE_TO_APP[it.href.toLowerCase()] || 'home';
          if (!signedIn) return true;
          return window.bccCanAccess(key);
        });
        if (visibleItems.length === 0) return; // skip empty groups
        html += '<div class="bcc-mm-group">';
        html += '<div class="bcc-mm-grouplabel">' + escapeHtml(grp.label) + '</div>';
        visibleItems.forEach(function (it) {
          var current = (it.href.toLowerCase() === here) ? ' bcc-mm-current' : '';
          html += '<a class="bcc-mm-link' + current + '" href="' + it.href + '">' +
                    '<span class="bcc-mm-ic">' + it.icon + '</span>' +
                    '<span>' + escapeHtml(it.name) + '</span>' +
                  '</a>';
        });
        html += '</div>';
      });

      // Footer: feedback + sign in/out action
      html += '<div class="bcc-mm-foot">';
      if (signedIn) html += '<a href="#" class="bcc-mm-feedback">💬 Send feedback</a>';
      if (signedIn) html += '<a href="#" class="bcc-mm-signout">Sign out</a>';
      else          html += '<a href="#" class="bcc-mm-signin">Sign in with Microsoft</a>';
      html += '</div>';

      drawer.innerHTML = html;
      document.body.appendChild(drawer);

      function closeMenu() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
        hamb.classList.remove('open');
        hamb.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      }
      function openMenu() {
        drawer.classList.add('open');
        backdrop.classList.add('open');
        hamb.classList.add('open');
        hamb.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
      }
      hamb.addEventListener('click', function (e) {
        e.stopPropagation();
        if (drawer.classList.contains('open')) closeMenu(); else openMenu();
      });
      drawer.querySelector('.bcc-mm-close').addEventListener('click', closeMenu);
      backdrop.addEventListener('click', closeMenu);
      // Tapping a link inside the drawer should close it (navigation happens)
      drawer.addEventListener('click', function (e) {
        var a = e.target.closest('a');
        if (!a) return;
        if (a.classList.contains('bcc-mm-signin')) { e.preventDefault(); closeMenu(); bccSignIn(); return; }
        if (a.classList.contains('bcc-mm-signout')) { e.preventDefault(); closeMenu(); bccSignOut(); return; }
        if (a.classList.contains('bcc-mm-feedback')) { e.preventDefault(); closeMenu(); window.bccOpenFeedback(); return; }
        closeMenu();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) closeMenu();
      });
    }
  }

  function setSyncState(state) {
    var chip = document.getElementById('bcc-auth-chip');
    if (!chip) return;
    chip.classList.remove('syncing', 'error');
    if (state === 'pushing') chip.classList.add('syncing');
    else if (state === 'error') chip.classList.add('error');
  }

  /* ---------- Toast notifications ----------
   * window.bccNotify(message, kind?, duration?)
   *   kind: 'info' (default) | 'success' | 'error' | 'warn'
   *   duration: ms before auto-dismiss (default 3500, 0 = sticky)
   * Stacks multiple at once; each can be dismissed individually.
   * Non-blocking — does NOT replace `alert()` calls anywhere yet;
   * available for new code to opt in.
   */
  window.bccNotify = function (message, kind, duration) {
    if (!document.body) return;
    var wrap = document.getElementById('bcc-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'bcc-toast-wrap';
      wrap.className = 'bcc-toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    var icons = { success: '✓', error: '⚠', warn: '⚠', info: 'ⓘ' };
    var t = document.createElement('div');
    t.className = 'bcc-toast ' + (kind || 'info');
    t.innerHTML = '<span class="ic">' + (icons[kind] || icons.info) + '</span>' +
                  '<span class="msg"></span>' +
                  '<button class="x" aria-label="Dismiss">&times;</button>';
    t.querySelector('.msg').textContent = String(message == null ? '' : message);
    wrap.appendChild(t);
    // requestAnimationFrame so the entry transition runs.
    requestAnimationFrame(function () { t.classList.add('show'); });
    var ttl = (duration == null) ? 3500 : duration;
    var dismiss = function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    };
    t.querySelector('.x').onclick = dismiss;
    if (ttl > 0) setTimeout(dismiss, ttl);
    return dismiss;
  };

  /* flush() dispatches 'bcc-sync-error' for every key in a refused PUT batch, but
   * nothing ever listened for it — a save silently stopped syncing with only a tiny
   * color change on the auth chip as any indication. A 401 specifically means the
   * SWA session has expired (a routine mid-day occurrence), so surface that clearly
   * and just once per page load rather than once per refused key. */
  var _sessionExpiredNotified = false;
  var _lastPermissionToastAt = 0;
  window.addEventListener('bcc-sync-error', function (ev) {
    var status = ev && ev.detail && ev.detail.status;
    if (status === 401) {
      if (_sessionExpiredNotified) return;
      _sessionExpiredNotified = true;
      // The queued writes are NOT lost — flush() re-queues on a 401 and retries, so
      // signing back in flushes them. Say so, or people re-type work they still have.
      if (window.bccNotify) window.bccNotify('Your sign-in has expired. Your unsaved changes are still queued — sign back in and they’ll finish saving.', 'error', 0);
    } else if (status === 403) {
      // A permission-tier rejection (e.g. CRM/Engagements/Marketing/Rate Sheet set
      // to View or None): the local edit LOOKS saved (optimistic write), but the
      // server refused it and it will never reach anyone else. Without this, that
      // failure was completely silent. Debounced so a batch of refused writes
      // (e.g. a CSV import) shows one toast, not one per row.
      var now = Date.now();
      if (now - _lastPermissionToastAt < 4000) return;
      _lastPermissionToastAt = now;
      if (window.bccNotify) window.bccNotify('That change wasn’t saved — you don’t have permission to edit this.', 'warn', 7000);
    } else if (status) {
      // Anything else the server refused (400 bad shape, 404, 409 conflict, 413 too
      // large…). There used to be no final branch here at all, so those failed exactly
      // as silently as the bug this listener was added to fix.
      var nowOther = Date.now();
      if (nowOther - _lastPermissionToastAt < 4000) return;
      _lastPermissionToastAt = nowOther;
      /* A TRANSIENT failure (408/429/5xx) has already been re-queued by flush() and will
         retry on its own, so telling the user their change "wasn't saved" made them re-type
         work that was never lost. Checked HERE, after the 401 branch above — a 401 is also
         flagged transient, and it needs its own "sign back in" message, not this one. */
      if (window.bccNotify) {
        window.bccNotify(
          (ev.detail && ev.detail.transient)
            ? ('Saving is taking a moment (error ' + status + ') — your change is still queued and will retry automatically.')
            : ('That change wasn’t saved (error ' + status + ') — it is still here on this device. Use the bar at the top of the page to try again once an admin has checked your access.'),
          'warn', 9000);
      }
      // The toast is gone in nine seconds; the bar is what is still there tomorrow.
      try { refreshRefusedBar(); } catch (e) {}
    }
  });

  /* ---------- Offline-aware save toast ----------
   * window.bccNotifySaved(onlineMsg)
   *   Online  → success toast with onlineMsg
   *   Offline → warn toast: "Saved locally — will sync when reconnected"
   * Form submit handlers (tm/trucking/hydrant/inspections) call this
   * instead of bccNotify directly so the message tells the truth.
   */
  window.bccNotifySaved = function (onlineMsg, ttl) {
    if (!window.bccNotify) { try { alert(onlineMsg); } catch (e) {} return; }
    /* signedIn is checked BEFORE navigator.onLine. The radio coming back does not mean the
       write went anywhere — on a tab that booted offline we may still have no principal — and
       a green "Saved." is the most expensive lie this file can tell. */
    if (_authUnknown) {
      window.bccNotify((onlineMsg ? onlineMsg + ' ' : '') + 'Saved on this device and queued. We haven’t been able to confirm your sign-in yet, so it will finish saving as soon as we can reach the server.', 'warn', 9000);
    } else if (navigator.onLine && signedIn) {
      window.bccNotify(onlineMsg || 'Saved.', 'success', ttl);
    } else if (!signedIn) {
      /* Offline AND unauthenticated. The setItem hook captures only the four
         OFFLINE_OWNED_PREFIXES families before sign-in (My Day's time log, my tasks, time
         entries, field forms) — those ARE queued and replayed at the next sign-in. Everything
         else (contacts, sessions, the schedule) is written to this device and nowhere else,
         and the next full pull writes the server's older copy straight over it.
         So ASK the outbox rather than assuming: telling a field crew their clock-in will not
         sync and to enter it again is its own kind of data loss, and the previous wording did
         exactly that. The write that triggered this toast has already happened, so a non-empty
         queue means it was captured. */
      /* Both halves, stated plainly. Deciding from "is ANYTHING in the outbox" was worse than
         either wording alone: this function is not told which key was written, so a queue left
         over from a different page promised a sync for a save that was never captured. */
      window.bccNotify((onlineMsg ? onlineMsg + ' ' : '') + 'Saved on this device. You are not signed in: your time log, tasks and field forms are queued and will sync when you sign in — anything else stays on this device only, so make those changes again once you are signed in.', 'warn', 12000);
    } else {
      window.bccNotify((onlineMsg ? onlineMsg + ' ' : '') + 'Saved locally — will sync when reconnected.', 'warn', ttl || 5000);
    }
  };

  /* ---------- ZIP writer (store) + save-to-disk ----------
   * Builds a .zip in the browser with no dependency and no build step. It exists because
   * handing someone a whole set of files in one go needs the archive built SOMEWHERE, and
   * the two obvious alternatives are worse:
   *   - N sequential <a download> clicks: N browser prompts, no folder structure, and on a
   *     phone most of them are silently dropped.
   *   - a server-side zip: every blob would have to be buffered inside an Azure Static Web
   *     Apps managed function, which has a hard ~45s ceiling and a response cap. A client
   *     with 300 MB of statements would fail there and nowhere else, and the failure would
   *     arrive as a dead download rather than as a message.
   * The browser already fetches the bytes and has no timeout, so it builds the archive.
   *
   * STORE (no compression) on purpose. The payload is PDFs, JPEGs and Office files, all of
   * which are already compressed — deflate would buy a few percent in exchange for a second
   * implementation, and a second failure mode, in code that has no build step to catch it.
   * Every size is known before its header is written, so no data descriptors either.
   *
   * NOT ZIP64: it refuses past 4 GB or 65534 entries rather than writing an archive that
   * Windows Explorer opens as empty. A refusal you can read beats a file that lies.
   *
   * Memory: each file's bytes are copied into a Blob and the typed array dropped, so the JS
   * heap only ever holds one file at a time — the browser backs the Blob with disk when it
   * needs to. Only the small headers stay in memory.
   */
  var _bccCrcTable = null;
  function _bccCrc32(u8) {
    if (!_bccCrcTable) {
      _bccCrcTable = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _bccCrcTable[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ _bccCrcTable[(crc ^ u8[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }
  function _bccW16(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF; }
  function _bccW32(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF; a[o + 2] = (v >>> 16) & 0xFF; a[o + 3] = (v >>> 24) & 0xFF; }
  // MS-DOS date/time, which is what ZIP stores. Its epoch is 1980 and it has 2-second
  // resolution; anything earlier is clamped rather than wrapping into a nonsense year.
  function _bccDosStamp(ms) {
    var d = new Date(typeof ms === 'number' && isFinite(ms) ? ms : Date.now());
    if (isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    if (y < 1980) { d = new Date(1980, 0, 1); y = 1980; }
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
      date: (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }
  /* Path INSIDE the archive. Backslashes become separators (ZIP uses '/'), leading slashes
     and any '..' segment are dropped: an entry named '../../x' is a real, exploited class of
     bug in unzippers, and this app has no business emitting one. */
  function _bccZipPath(path) {
    var segs = String(path == null ? '' : path).replace(/\\/g, '/').split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i].replace(/[\x00-\x1f\x7f]/g, '').trim();
      if (!sg || sg === '.' || sg === '..') continue;
      out.push(sg);
    }
    return out.join('/') || 'file';
  }
  var BCC_ZIP_MAX_BYTES = 4 * 1024 * 1024 * 1024 - 1;   // 32-bit offsets/sizes without ZIP64
  var BCC_ZIP_MAX_FILES = 65534;                        // 16-bit entry count without ZIP64
  window.bccZip = function () {
    var parts = [], central = [], offset = 0, n = 0;
    var enc = new TextEncoder();
    function add(path, bytes, whenMs) {
      var name = enc.encode(_bccZipPath(path));
      /* Measure BEFORE converting. Reading the length off the input costs nothing, while
         `new Uint8Array(huge)` allocates a second copy — so checking the ceiling afterwards
         meant the one input the ceiling exists to refuse would take the tab down before the
         refusal could be thrown. */
      var len = (bytes && typeof bytes.byteLength === 'number') ? bytes.byteLength
              : ((bytes && typeof bytes.length === 'number') ? bytes.length : 0);
      if (n >= BCC_ZIP_MAX_FILES) throw new Error('too many files for one zip (' + BCC_ZIP_MAX_FILES + ' max)');
      if (offset + 30 + name.length + len > BCC_ZIP_MAX_BYTES) throw new Error('zip would exceed 4 GB');
      var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || 0);
      var st = _bccDosStamp(whenMs), crc = _bccCrc32(u8);
      var h = new Uint8Array(30 + name.length);
      _bccW32(h, 0, 0x04034b50);
      _bccW16(h, 4, 20);            // version needed
      _bccW16(h, 6, 0x0800);        // flag bit 11: the name below is UTF-8
      _bccW16(h, 8, 0);             // method 0 = store
      _bccW16(h, 10, st.time); _bccW16(h, 12, st.date);
      _bccW32(h, 14, crc); _bccW32(h, 18, u8.length); _bccW32(h, 22, u8.length);
      _bccW16(h, 26, name.length); _bccW16(h, 28, 0);
      h.set(name, 30);
      parts.push(h);
      // Copy into a Blob so the caller's typed array can be released immediately.
      parts.push(new Blob([u8]));
      central.push({ name: name, crc: crc, size: u8.length, time: st.time, date: st.date, off: offset });
      offset += h.length + u8.length;
      n++;
      return true;
    }
    function addText(path, text, whenMs) { return add(path, enc.encode(String(text == null ? '' : text)), whenMs); }
    function finish() {
      var cdSize = 0, i;
      for (i = 0; i < central.length; i++) cdSize += 46 + central[i].name.length;
      var cd = new Uint8Array(cdSize), o = 0;
      for (i = 0; i < central.length; i++) {
        var e = central[i];
        _bccW32(cd, o, 0x02014b50);
        _bccW16(cd, o + 4, 20); _bccW16(cd, o + 6, 20);
        _bccW16(cd, o + 8, 0x0800); _bccW16(cd, o + 10, 0);
        _bccW16(cd, o + 12, e.time); _bccW16(cd, o + 14, e.date);
        _bccW32(cd, o + 16, e.crc); _bccW32(cd, o + 20, e.size); _bccW32(cd, o + 24, e.size);
        _bccW16(cd, o + 28, e.name.length); _bccW16(cd, o + 30, 0); _bccW16(cd, o + 32, 0);
        _bccW16(cd, o + 34, 0); _bccW16(cd, o + 36, 0); _bccW32(cd, o + 38, 0);
        _bccW32(cd, o + 42, e.off);
        cd.set(e.name, o + 46);
        o += 46 + e.name.length;
      }
      var eo = new Uint8Array(22);
      _bccW32(eo, 0, 0x06054b50);
      _bccW16(eo, 4, 0); _bccW16(eo, 6, 0);
      _bccW16(eo, 8, central.length); _bccW16(eo, 10, central.length);
      _bccW32(eo, 12, cdSize); _bccW32(eo, 16, offset);
      _bccW16(eo, 20, 0);
      return new Blob(parts.concat([cd, eo]), { type: 'application/zip' });
    }
    return {
      add: add,
      addText: addText,
      finish: finish,
      count: function () { return n; },
      bytes: function () { return offset; }
    };
  };
  /* Hand a Blob to the user as a download. One implementation, because the two hand-rolled
     copies of this in bookkeeping.html differ in whether they revoke the object URL — and a
     URL that is never revoked pins the whole blob in memory for the life of the tab, which
     for an archive of a client's files can be hundreds of megabytes. */
  window.bccSaveBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'download');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Revoke LATE: revoking synchronously cancels the download in some browsers, because the
    // navigation the click starts has not read the blob yet.
    setTimeout(function () { try { a.remove(); } catch (e) {} URL.revokeObjectURL(url); }, 60000);
  };
  /* A filename Windows, macOS and every zip tool will accept. \\ / : * ? " < > | are illegal
     on Windows and a stray one turns a saved file into a silent failure. */
  var _BCC_WIN_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  window.bccSafeFileName = function (name, fallback) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '');      // a leading dot hides the file on unix and confuses Explorer
    /* Truncate the STEM, never the extension. Chopping a long name at a fixed length took
       ".pdf" off the end, and a file with no extension is one Windows will not open — a
       silent break in the middle of an archive nobody is going to check file by file. */
    if (s.length > 120) {
      var dot = s.lastIndexOf('.');
      var ext = (dot > 0 && s.length - dot <= 12) ? s.slice(dot) : '';
      s = s.slice(0, 120 - ext.length).trim() + ext;
    }
    s = s.trim();
    /* CON, PRN, AUX, NUL, COM1-9, LPT1-9 are reserved DEVICE names on Windows, with or
       without an extension: "CON.pdf" cannot be created, so the whole extraction fails on
       that one entry. Prefixing keeps the name readable and the file openable. */
    var stemOnly = s.replace(/\.[^.]*$/, '');
    if (_BCC_WIN_DEVICES.test(stemOnly)) s = '_' + s;
    return s || String(fallback || 'file');
  };

  /* ---------- Offline banner ----------
   * Pinned amber bar across the very top whenever the browser reports the
   * network is down. Saves are still queued by the sync layer; this just
   * tells the user so they know their data isn't lost. */
  function refreshOnlineState() {
    var bar = document.getElementById('bcc-offline-bar');
    if (navigator.onLine) {
      if (bar) bar.classList.remove('show');
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bcc-offline-bar';
      bar.className = 'bcc-offline';
      bar.textContent = '⚠ You are offline. Your changes will sync when the connection returns.';
      (document.body || document.documentElement).appendChild(bar);
    }
    /* Re-worded every time it is shown, not just when first created — the banner outlives the
       state that produced it, and a flat "will sync" is false when we never authenticated.
       Signed out, the truth is split: the offline-owned families (time log, my tasks, time
       entries, field forms) are queued and replayed; nothing else is. Say both halves rather
       than a blanket "will NOT sync" that would send a field crew back to re-enter work that
       is safely queued. */
    bar.textContent = signedIn
      ? '⚠ You are offline. Your changes will sync when the connection returns.'
      : (_authUnknown
        ? '⚠ You are offline. Your changes are being saved on this device and will sync when the connection returns.'
        : '⚠ You are offline and not signed in. Your time log, tasks and field forms are saved and will sync when you sign in; other changes stay on this device only.');
    bar.classList.add('show');
    placeOfflineBar(bar);
  }
  /* Sit UNDER the topbar, never over it. Every page declares
     header.topbar{position:sticky;top:0;z-index:50}, so a sticky/fixed topbar always owns the
     first N px of the viewport; a banner pinned at top:0 covered it, and on a phone that
     topbar holds the hamburger — the only navigation and the only way to sign out. The height
     is measured rather than assumed because this banner wraps to 2-4 lines on a narrow screen
     and the topbar itself can wrap. A static (non-sticky) topbar scrolls away, so there is
     nothing to clear and the banner stays at 0. */
  function placeOfflineBar(bar) {
    bar = bar || document.getElementById('bcc-offline-bar');
    if (!bar) return;
    var top = 0;
    /* Two bars can be up at once — offline AND changes the server refused. Stack them, or the
       second covers the first and the person only ever sees one of two things they need to
       know. The offline bar keeps the topbar offset; the refused bar sits under it. */
    /* Up to three bars can be showing — offline, refused changes, incomplete load. Stack them
       in a fixed order: each sits below the ones ranked above it that are currently up.
       Without this the last one painted covered the others, and the person saw one of three
       things they needed to know. */
    var ORDER = ['bcc-offline-bar', 'bcc-refused-bar', 'bcc-incomplete-bar'];
    var myIdx = ORDER.indexOf(bar.id);
    if (myIdx > 0) {
      var stacked = null;
      for (var oi = myIdx - 1; oi >= 0; oi--) {
        var above = document.getElementById(ORDER[oi]);
        if (above && above.classList.contains('show')) { stacked = above; break; }
      }
      if (stacked) {
        try {
          var r = stacked.getBoundingClientRect();
          bar.style.top = Math.round(r.bottom) + 'px';
          return;
        } catch (e) {}
      }
    }
    try {
      var tb = document.querySelector('header.topbar');
      if (tb) {
        var pos = (window.getComputedStyle(tb) || {}).position;
        if (pos === 'sticky' || pos === 'fixed') top = Math.round(tb.getBoundingClientRect().height) || 0;
      }
    } catch (e) { top = 0; }
    bar.style.top = top + 'px';
  }
  window.addEventListener('resize', function () {
    ['bcc-offline-bar', 'bcc-refused-bar', 'bcc-incomplete-bar'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b && b.classList.contains('show')) placeOfflineBar(b);
    });
  });
  window.addEventListener('online',  refreshOnlineState);
  window.addEventListener('offline', refreshOnlineState);
  /* ...and again once the verdict is IN. This file is deferred, so the immediate call below
     runs before bootstrap has asked /.auth/me — and the banner's wording is chosen entirely
     from signedIn/_authUnknown, so an offline boot told a signed-in user that everything but
     their time log "stays on this device only". bcc-auth-ready is dispatched at the end of
     every bootstrap, including the unknown-verdict one. */
  window.addEventListener('bcc-auth-ready', refreshOnlineState);
  /* The refused-changes bar is raised from the DURABLE outbox, so a reload — the thing people
     do after "that wasn't saved" — brings it straight back with the work still held. */
  window.addEventListener('bcc-auth-ready', function () { try { refreshRefusedBar(); } catch (e) {} try { refreshIncompleteBar(); } catch (e) {} });
  // The boot pull settles after bcc-auth-ready in some paths, and the live poll can set the
  // flag at any point in the session — so check again whenever data lands.
  window.addEventListener('bcc-data-ready', function () { try { refreshIncompleteBar(); } catch (e) {} });
  // Defer the first check until DOM is ready so we can append to <body>.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { refreshOnlineState(); try { refreshRefusedBar(); } catch (e) {} try { refreshIncompleteBar(); } catch (e) {} });
  } else {
    refreshOnlineState();
    try { refreshRefusedBar(); } catch (e) {}
    try { refreshIncompleteBar(); } catch (e) {}
  }

  /* ---------- Auto-lazy <img> ----------
   * Past-logs and past-inspections lists render every record's photos as
   * inline <img> tags. With a few weeks of field work each user can rack
   * up dozens of base64-encoded photos in localStorage — eagerly loading
   * every one when the list paints is costly. A MutationObserver watches
   * for new <img> elements and sets loading="lazy" + decoding="async" on
   * any that don't already have it. Native browser lazy-loading then
   * defers off-screen images until they're scrolled into view.
   */
  if ('MutationObserver' in window) {
    var imgObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'IMG') applyLazy(n);
          else if (n.querySelectorAll) {
            var imgs = n.querySelectorAll('img');
            for (var k = 0; k < imgs.length; k++) applyLazy(imgs[k]);
          }
        }
      }
    });
    function applyLazy(img) {
      // Skip the topbar logo and any image explicitly marked eager —
      // those should paint immediately to avoid CLS / brand pop-in.
      if (img.getAttribute('fetchpriority') === 'high') return;
      if (img.dataset && img.dataset.eager === '1') return;
      if (img.closest && img.closest('header.topbar, .hero, .brand')) return;
      if (!img.hasAttribute('loading'))  img.setAttribute('loading',  'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    }
    // Existing images already in the document at script-load time.
    if (document.body) {
      var initialImgs = document.body.getElementsByTagName('img');
      for (var ii = 0; ii < initialImgs.length; ii++) applyLazy(initialImgs[ii]);
    }
    imgObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- Global error boundary ----------
   * If a page's inline script throws an uncaught exception or a Promise
   * rejects without a handler, show a friendly toast rather than letting
   * the page silently fail. Logs to console for debugging. */
  window.addEventListener('error', function (e) {
    try {
      if (window.bccNotify) window.bccNotify(
        'Something went wrong on this page. Refresh, or contact admin if it keeps happening.',
        'error', 6000
      );
      console.error('[pc] uncaught error:', e.error || e.message, e);
    } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      console.error('[pc] unhandled rejection:', e.reason);
    } catch (_) {}
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- Shared "new job" modal ---------- */
  // Promise-based: resolves with the new job object, or null if cancelled.
  // Saves directly to localStorage['bcc-schedule-v1'] (the sync layer pushes
  // it to Cosmos via the hooked setItem on the next debounce tick).
  window.bccOpenNewJobModal = function (opts) {
    opts = opts || {};
    var defaults = opts.defaults || {};
    return new Promise(function (resolve) {
      var existing = document.getElementById('bcc-newjob-modal');
      if (existing) existing.remove();

      function ea(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
      var types = [
        ['watersewer','Water / Sewer'],['hydrovac','Hydrovac'],['excavation','Excavation'],
        ['firehydrant','Fire Hydrant'],['demo','Demolition'],['emergency','Emergency'],['other','Other']
      ];
      var typeOpts = types.map(function(t){
        return '<option value="'+t[0]+'"'+((defaults.type||'other')===t[0]?' selected':'')+'>'+t[1]+'</option>';
      }).join('');

      var modal = document.createElement('div');
      modal.id = 'bcc-newjob-modal';
      modal.className = 'bcc-modal-overlay open';
      modal.innerHTML =
        '<div class="bcc-modal-card">' +
          '<h3>Add a new job</h3>' +
          '<p class="bcc-modal-sub">Saves to the scheduler instantly &mdash; available everywhere a job is picked.</p>' +
          '<label>Job name / work description <span class="bcc-req">*</span></label>' +
          '<input id="bcc-nj-name" placeholder="e.g. Sewer line repair" value="'+ea(defaults.name)+'" />' +
          '<div class="bcc-row-2">' +
            '<div><label>Customer</label><input id="bcc-nj-customer" placeholder="e.g. City of Burnsville" value="'+ea(defaults.customer)+'" /></div>' +
            '<div><label>Type</label><select id="bcc-nj-type">'+typeOpts+'</select></div>' +
          '</div>' +
          '<label>Address / location</label>' +
          '<input id="bcc-nj-location" placeholder="Street, city" value="'+ea(defaults.location)+'" />' +
          '<label>Estimated hours</label>' +
          '<input id="bcc-nj-hours" type="number" min="0" step="0.5" value="'+(defaults.hours||0)+'" />' +
          '<label>Notes</label>' +
          '<textarea id="bcc-nj-notes" placeholder="Permit on file, locates marked, etc.">'+ea(defaults.notes)+'</textarea>' +
          '<div class="bcc-modal-actions">' +
            '<button class="bcc-btn-ghost"   id="bcc-nj-cancel">Cancel</button>' +
            '<button class="bcc-btn-primary" id="bcc-nj-save">Create job</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      var resolved = false;
      function close(result) {
        if (resolved) return;
        resolved = true;
        modal.classList.remove('open');
        setTimeout(function(){ if (modal.parentNode) modal.parentNode.removeChild(modal); }, 180);
        document.removeEventListener('keydown', escHandler);
        resolve(result);
      }

      function escHandler(e) {
        if (e.key === 'Escape') close(null);
      }
      document.addEventListener('keydown', escHandler);
      modal.addEventListener('click', function(e){ if (e.target === modal) close(null); });

      document.getElementById('bcc-nj-cancel').onclick = function(){ close(null); };
      document.getElementById('bcc-nj-save').onclick = function(){
        var name     = document.getElementById('bcc-nj-name').value.trim();
        var customer = document.getElementById('bcc-nj-customer').value.trim();
        var location = document.getElementById('bcc-nj-location').value.trim();
        var type     = document.getElementById('bcc-nj-type').value;
        var hours    = parseFloat(document.getElementById('bcc-nj-hours').value) || 0;
        var notes    = document.getElementById('bcc-nj-notes').value.trim();
        if (!name) { alert('Job name is required.'); document.getElementById('bcc-nj-name').focus(); return; }

        var sch;
        try { sch = JSON.parse(localStorage.getItem('bcc-schedule-v1')) || {}; } catch (e) { sch = {}; }
        if (!sch.jobs) sch.jobs = [];
        var newJob = {
          id: 'j' + Date.now(),
          name: name, customer: customer, location: location, type: type, notes: notes,
          members: [], equipment: [], hours: hours,
          crewId: null, day: null,
          boardStatus: 'new',
          contacts: [], checklist: { items: [] }, emailSource: null,
          attachments: { photos: [], files: [], notes: [] },
          createdAt: new Date().toISOString(),
          createdBy: localStorage.getItem('bcc-field-who') || (window.bccUser && window.bccUser.userDetails) || 'unknown'
        };
        sch.jobs.push(newJob);
        // Use the hooked setItem so the cloud-sync push fires
        localStorage.setItem('bcc-schedule-v1', JSON.stringify(sch));
        // Activity log: a new job was created.
        if (window.bccAudit) {
          window.bccAudit('job-create', {
            key: newJob.id,
            meta: { name: newJob.name, customer: newJob.customer || null, type: newJob.type, hours: newJob.hours || null }
          });
        }
        close(newJob);
      };

      setTimeout(function(){
        var el = document.getElementById('bcc-nj-name');
        if (el) el.focus();
      }, 50);
    });
  };

  /* ---------- Geolocation + weather helpers (shared) ----------
   * Every submission page used to declare its own bccGetLocation /
   * bccMapsUrl / bccLocChip. They're identical, so live on window.* now.
   * bccGetWeather fetches current conditions from Open-Meteo (free, no key
   * needed) so weather + temp can be pre-filled on logs.
   */
  window.bccGetLocation = function (opts) {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var t = (opts && opts.timeout) || 8000;
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() }); },
        function () { resolve(null); },
        { timeout: t, maximumAge: 60000, enableHighAccuracy: false }
      );
    });
  };
  window.bccMapsUrl = function (loc) {
    return (loc && isFinite(loc.lat) && isFinite(loc.lng))
      ? ('https://maps.google.com/?q=' + loc.lat + ',' + loc.lng) : null;
  };
  window.bccLocChip = function (loc, label) {
    if (!loc) return '';
    var url = window.bccMapsUrl(loc);
    var txt = label || (loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4));
    return '<a class="loc-chip" href="' + url + '" target="_blank" rel="noopener">&#128205; ' + txt + '</a>';
  };

  // WMO weather code → our weather id ('sunny','cloudy','overcast','rain','snow','wind','cold','hot')
  function wmoToWeather(code, tempF) {
    if (code === 0 || code === 1) return tempF >= 85 ? 'hot' : 'sunny';
    if (code === 2) return 'cloudy';
    if (code === 3 || code === 45 || code === 48) return 'overcast';
    if (code >= 51 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';
    if (code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'rain';
    return 'cloudy';
  }

  // Returns {weather, tempF, windMph, loc} or null on failure.
  // Result cached for 10 min in sessionStorage so multiple form opens don't refetch.
  window.bccGetWeather = async function () {
    try {
      var cached = sessionStorage.getItem('bcc-weather-now');
      if (cached) {
        var c = JSON.parse(cached);
        if (c && (Date.now() - c.ts) < 10 * 60 * 1000) return c;
      }
    } catch (e) {}
    var loc = await window.bccGetLocation({ timeout: 6000 });
    if (!loc) return null;
    try {
      var url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=' + loc.lat
        + '&longitude=' + loc.lng
        + '&current=temperature_2m,weather_code,wind_speed_10m'
        + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
      var r = await fetch(url);
      if (!r.ok) return null;
      var j = await r.json();
      var cur = j && j.current;
      if (!cur) return null;
      var tempF = Math.round(cur.temperature_2m);
      var windMph = Math.round(cur.wind_speed_10m || 0);
      var result = { weather: wmoToWeather(cur.weather_code, tempF), tempF: tempF, windMph: windMph, loc: loc, ts: Date.now() };
      // Wind-overrides if it's gusty
      if (windMph >= 20 && result.weather !== 'rain' && result.weather !== 'snow') result.weather = 'wind';
      if (tempF <= 35 && result.weather !== 'snow' && result.weather !== 'rain') result.weather = 'cold';
      try { sessionStorage.setItem('bcc-weather-now', JSON.stringify(result)); } catch (e) {}
      return result;
    } catch (e) {
      return null;
    }
  };

  // Convenience: "HH:MM" string for an <input type="time"> default
  window.bccNowTime = function () {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  // "YYYY-MM-DD" for an <input type="date"> default
  window.bccTodayIso = function () {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  /* ---------- Audit log helper ----------
   * Fire-and-forget POST to /api/audit. Server fills in the user identity
   * (from SWA principal), client IP, user-agent, and timestamp; the caller
   * only needs to supply the action and (optionally) path/key/meta context.
   *
   * Anonymous users are skipped — the endpoint requires auth anyway.
   * Failures are silently swallowed; we never want audit to break the app.
   */
  window.bccAudit = function (action, payload) {
    if (!signedIn) return;
    try {
      var body = JSON.stringify(Object.assign(
        { action: action, path: location.pathname + location.hash },
        payload || {}
      ));
      // keepalive lets the request survive page unload (so a sign-out audit
      // event has a chance to land even if the page is closing).
      fetch(API_BASE + '/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  };

  /* ---------- public API ---------- */
  window.bccSignIn = function () {
    // Force the Microsoft account picker — important on mobile where multiple
    // company accounts are commonly cached. Silent sign-in there grabs the
    // first one and frequently traps us in a wrong-domain loop. The picker
    // adds one tap for single-account users but eliminates the loop entirely.
    var redir = encodeURIComponent(location.pathname + location.search + location.hash);
    location.href = '/.auth/login/aad?prompt=select_account&domain_hint=bluecollarcoach.us&post_login_redirect_uri=' + redir;
  };
  window.bccSignOut = function () {
    // Writes are debounced (PUSH_DEBOUNCE_MS) and re-queued on a transient failure, so
    // signing out right after a save used to walk away from whatever was still in the
    // queue — the edit was simply gone on the next sign-in. Push it first, and if that
    // can't be done, let them decide rather than losing it silently.
    // flush() clears `pending` SYNCHRONOUSLY before its first await, so re-reading
    // pending.size after calling it always saw 0 and the confirm never appeared —
    // sign-out cancelled the in-flight PUT without asking. Count first.
    /* Retire THIS device's push subscription. A Web Push subscription belongs to the
       browser profile and origin, not to the signed-in person — so without this, a shared
       or handed-on machine kept delivering the previous user's notifications indefinitely,
       and the next person to tap "Enable alerts" re-registered the SAME endpoint under
       their own name on top of it.
       Deliberately fire-and-forget, and endpoint-scoped:
         - navigator.serviceWorker.ready NEVER settles when nothing controls the scope
           (SW registration is best-effort, and absent in iOS private browsing), so
           awaiting it here could wedge sign-out permanently. Nothing below waits on it.
         - ?endpoint= removes only this device's row. The unscoped DELETE means "turn
           notifications off for my account" and would kill push on their phone too. */
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (!reg || !reg.pushManager) return;
          return reg.pushManager.getSubscription().then(function (sub) {
            if (!sub) return;
            var ep = sub.endpoint;
            try { sub.unsubscribe(); } catch (e) {}
            // keepalive so the request survives the navigation below.
            try { fetch(API_BASE + '/push-subscribe?endpoint=' + encodeURIComponent(ep), { method: 'DELETE', keepalive: true }); } catch (e) {}
          });
        }).catch(function () {});
      }
      _origRemoveItem.call(localStorage, 'bcc-push-enabled');
    } catch (e) {}

    /* `pending` is CLEARED by _flushOnce before its first await, so for the entire duration of
       an in-flight PUT it reads 0 — exactly the moment this branch matters most. inFlight
       carries the sentinel 0 for a key whose request is still open (it is rewritten to a real
       expiry once the flush settles), so it is the signal that actually means "a request is
       open right now". Without this, clicking Sign out during the 1.2s push debounce aborted
       the write and skipped the confirmation the code promises. */
    var _openNow = 0;
    try { inFlight.forEach(function (v) { if (v === 0) _openNow++; }); } catch (e) {}
    var queued = pending.size + _openNow;
    if (queued) {
      // Give the flush a real chance to land before navigating away, but never wait on
      // it indefinitely — flush() can issue a batch PUT plus N per-key PUTs plus N
      // DELETEs sequentially, so a slow server would wedge sign-out with no feedback.
      if (pushTimer) clearTimeout(pushTimer);
      var done = false, settled = false;
      var go = function () {
        if (done) return; done = true;
        // Ask ONLY on the timeout path, i.e. the flush has not settled and navigating away
        // would abort a request that is still open. Do not re-read pending.size to decide:
        // flush() clears it synchronously before its first await, so mid-flight it is
        // always 0 — which is exactly how the previous version skipped the confirm and
        // killed the in-flight PUT, the very thing it was written to prevent. Report the
        // count captured BEFORE the flush for the same reason.
        // Cancel must be FINAL, so `done` stays true. Resetting it to false left the flush
        // continuation armed: settleThenGo would later call go() again, find done === false
        // and settled === true, skip the confirm entirely and sign the user out anyway.
        // confirm() also blocks the thread, so a flush that finished while the dialog was
        // open signed them out the instant they pressed Cancel.
        if (!settled && !confirm(queued + ' change' + (queued === 1 ? '' : 's') + ' ' + (queued === 1 ? 'is' : 'are') + ' still saving. They are stored on this device and will finish saving next time you sign in here. Sign out now?')) return;
        window.bccAudit && window.bccAudit('signout');
        location.href = '/.auth/logout?post_logout_redirect_uri=' + encodeURIComponent(location.origin + '/');
      };
      var settleThenGo = function () { settled = true; go(); };
      try { Promise.resolve(flush()).then(settleThenGo, settleThenGo); } catch (e) { settleThenGo(); }
      setTimeout(go, 2500);
      return;
    }
    window.bccAudit && window.bccAudit('signout');
    location.href = '/.auth/logout?post_logout_redirect_uri=' + encodeURIComponent(location.origin + '/');
  };
  window.bccSyncNow = function () {
    if (pushTimer) clearTimeout(pushTimer);
    return flush();
  };
  window.bccHasRole = function (role) {
    return !!(user && user.userRoles && user.userRoles.indexOf(role) >= 0);
  };

  /* ---------- Admin check ----------
   * Source of truth that mirrors the server: a user is admin if they hold
   * the legacy SWA 'administrator' role OR they're listed in
   * bcc-admin-config-v1.users with role:'admin' and status not 'inactive'.
   *
   * Bootstrap: ONLY when the admin config doesn't exist at all (or has an
   * empty users array). Once any users are present in the config — even
   * non-admins — admin role becomes mandatory. This stops the previous
   * "no admins set → everyone is admin" loophole. To recover from a
   * lockout, give the user the SWA 'administrator' role in the Azure
   * portal (one-time), or add them to BCC_OWNER_UPNS server-side.
   */
  window.bccIsAdmin = function () {
    // 1) Server's verdict wins when we have it (honors BCC_OWNER_UPNS and
    //    SWA 'administrator' role recovery paths server-side).
    if (window.__pcServerIsAdmin === true)  return true;
    if (window.__pcServerIsAdmin === false) return false;

    // 2) Fallback when server hasn't answered yet (offline / pre-bootstrap):
    //    legacy SWA 'administrator' role still grants access.
    if (window.bccHasRole && window.bccHasRole('administrator')) return true;
    if (!user || !user.userDetails) return false;
    var who = String(user.userDetails).toLowerCase();
    try {
      var raw = localStorage.getItem('bcc-admin-config-v1');
      var cfg = raw ? JSON.parse(raw) : null;
      /* The bootstrap arms are for a FIRST DEPLOY — a successful pull that found no config.
         They fired identically on any cold browser whose pull merely FAILED, and
         bccGetAppPermission('admin') delegates straight here, so bccEnforcePagePermission
         resolved 'admin' and lifted the overlay from Admin and the Activity log for whoever
         was signed in. That is the exact opposite of the rule the overlay documents
         ("deliberately still blocking when the pull failed"). Require evidence that we
         actually heard from the server; the recovery paths above (__pcServerIsAdmin and the
         SWA 'administrator' role) are unaffected, and they are what a real lockout uses. */
      var heardFromServer = !window._bccBootPullFailed && window._bccBootPullOk === true;
      if (!cfg) return heardFromServer;                // no config yet (first deploy)
      var users = Array.isArray(cfg.users) ? cfg.users : [];
      if (!users.length) return heardFromServer;       // empty list (cloud hasn't synced)
      // From here on, admin role is REQUIRED. No "no admins set" exception.
      return users.some(function (u) {
        if (!u || u.role !== 'admin' || u.status === 'inactive') return false;
        return (u.upn   || '').toLowerCase() === who
            || (u.email || '').toLowerCase() === who
            || (u.name  || '').toLowerCase() === who;
      });
    } catch (e) { return false; }
  };

  /* ---------- Push notifications (additive) ----------
   *
   * Two public helpers + a soft banner. Everything is best-effort and
   * fails silently — push is a nice-to-have, never a hard dependency.
   *
   *   window.bccEnablePush()  -> request browser permission, subscribe, POST
   *                              to /api/push-subscribe. Resolves to true on
   *                              success, false on any failure.
   *   window.bccDisablePush() -> unsubscribe + DELETE on server.
   *
   * A subtle "Get notifications on this device?" banner appears for users
   * who:
   *   - are signed in,
   *   - have notifyOnSubmit === true in bcc-admin-config-v1.users,
   *   - have Notification.permission === 'default' (never asked yet),
   *   - haven't dismissed the banner this device-session.
   * Dismiss is sticky via localStorage so the banner doesn't nag.
   */
  function urlBase64ToUint8Array(b64) {
    var padding = '='.repeat((4 - (b64.length % 4)) % 4);
    var base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    return (typeof window !== 'undefined')
        && ('Notification' in window)
        && ('serviceWorker' in navigator)
        && ('PushManager' in window);
  }

  function getCurrentUserNotifyFlag() {
    try {
      if (!user || !user.userDetails) return false;
      var who = String(user.userDetails).toLowerCase();
      var raw = localStorage.getItem('bcc-admin-config-v1');
      var cfg = raw ? JSON.parse(raw) : null;
      if (!cfg || !Array.isArray(cfg.users)) return false;
      return cfg.users.some(function (u) {
        if (!u || u.status === 'inactive') return false;
        if (u.notifyOnSubmit !== true) return false;
        return (u.upn || '').toLowerCase() === who
            || (u.email || '').toLowerCase() === who;
      });
    } catch (e) { return false; }
  }

  window.bccEnablePush = async function () {
    if (!pushSupported()) {
      window.bccNotify && window.bccNotify('Push notifications not supported on this browser.', 'warn');
      return false;
    }
    if (!signedIn) {
      window.bccNotify && window.bccNotify('Sign in first to enable notifications.', 'warn');
      return false;
    }
    try {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        window.bccNotify && window.bccNotify('Notifications blocked. Enable them in your browser settings.', 'warn', 5000);
        return false;
      }
      var keyRes = await fetch(API_BASE + '/push-public-key');
      if (!keyRes.ok) throw new Error('public key fetch failed');
      var keyJson = await keyRes.json();
      var pubKey = keyJson && keyJson.publicKey;
      if (!pubKey) {
        window.bccNotify && window.bccNotify('Server not configured for push. Ask an admin to set VAPID keys.', 'warn', 6000);
        return false;
      }
      var reg = await navigator.serviceWorker.ready;
      var existing = await reg.pushManager.getSubscription();
      // A subscription is bound to the VAPID key it was minted with. Reusing one created
      // under a DIFFERENT (rotated, or previously misconfigured) key meant this reported
      // success while every push to it 403'd forever, with nothing to indicate why.
      // Compare the stored applicationServerKey against the one the server is using now,
      // and re-mint when they differ.
      if (existing) {
        var wanted = urlBase64ToUint8Array(pubKey);
        var have = null;
        try { have = existing.options && existing.options.applicationServerKey; } catch (_) {}
        var same = false;
        if (have) {
          var hv = new Uint8Array(have);
          same = hv.length === wanted.length;
          for (var ki = 0; same && ki < hv.length; ki++) if (hv[ki] !== wanted[ki]) same = false;
        }
        if (!same) {
          try { await existing.unsubscribe(); } catch (_) {}
          existing = null;
        }
      }
      var sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pubKey)
      });
      var postRes = await fetch(API_BASE + '/push-subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub })
      });
      if (!postRes.ok) throw new Error('subscribe POST failed: ' + postRes.status);
      try { localStorage.setItem('bcc-push-enabled', '1'); } catch (e) {}
      window.bccNotify && window.bccNotify('Notifications on for this device.', 'success');
      return true;
    } catch (e) {
      window.bccNotify && window.bccNotify('Could not enable notifications. Try again later.', 'warn');
      return false;
    }
  };

  window.bccDisablePush = async function () {
    if (!pushSupported()) return false;
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) {
        try { await sub.unsubscribe(); } catch (_) {}
      }
      try {
        await fetch(API_BASE + '/push-subscribe', { method: 'DELETE' });
      } catch (_) {}
      try { localStorage.removeItem('bcc-push-enabled'); } catch (e) {}
      window.bccNotify && window.bccNotify('Notifications off for this device.', 'info');
      return true;
    } catch (e) { return false; }
  };

  function maybeShowPushBanner() {
    try {
      if (!pushSupported()) return;
      if (!signedIn) return;
      if (Notification.permission !== 'default') return;
      if (!getCurrentUserNotifyFlag()) return;
      if (localStorage.getItem('bcc-push-banner-dismissed') === '1') return;
      if (document.getElementById('bcc-push-banner')) return;

      var bar = document.createElement('div');
      bar.id = 'bcc-push-banner';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Enable notifications');
      bar.style.cssText = [
        'position:fixed', 'left:12px', 'right:12px', 'bottom:12px',
        'z-index:9998',
        'background:#1f2937', 'color:#f8fafc',
        'border:1px solid #7a4848',
        'border-radius:10px',
        'padding:12px 14px',
        'display:flex', 'gap:10px', 'align-items:center', 'flex-wrap:wrap',
        'font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 8px 24px rgba(0,0,0,.25)',
        'max-width:560px', 'margin:0 auto'
      ].join(';');
      bar.innerHTML =
        '<span style="flex:1;min-width:180px">Get notified when a T&amp;M sheet or trucking slip is submitted?</span>' +
        '<button type="button" data-act="enable" style="background:#7a4848;color:#fff;border:0;padding:8px 14px;border-radius:8px;font-weight:600;cursor:pointer">Turn on</button>' +
        '<button type="button" data-act="dismiss" style="background:transparent;color:#cbd5e1;border:1px solid #475569;padding:8px 12px;border-radius:8px;cursor:pointer">Not now</button>';

      function teardown() { if (bar.parentNode) bar.parentNode.removeChild(bar); }
      bar.addEventListener('click', async function (ev) {
        var t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        var act = t.getAttribute('data-act');
        if (act === 'dismiss') {
          try { localStorage.setItem('bcc-push-banner-dismissed', '1'); } catch (e) {}
          teardown();
        } else if (act === 'enable') {
          t.disabled = true; t.textContent = 'Working…';
          var ok = await window.bccEnablePush();
          if (ok) {
            try { localStorage.setItem('bcc-push-banner-dismissed', '1'); } catch (e) {}
            teardown();
          } else {
            t.disabled = false; t.textContent = 'Turn on';
          }
        }
      });
      document.body.appendChild(bar);
    } catch (e) { /* best-effort */ }
  }

  // Show banner after auth + users settle. Both events fire on bootstrap.
  window.addEventListener('bcc-auth-ready', function () {
    // Defer until we've also seen the admin config sync down.
    setTimeout(maybeShowPushBanner, 1500);
  });
  window.addEventListener('bcc-users-ready', function () {
    setTimeout(maybeShowPushBanner, 500);
  });

  /* ====================================================================
   * In-app notification center + reminder/chat poller  (additive)
   * --------------------------------------------------------------------
   *  - A bell in the topbar with an unread badge + dropdown panel.
   *  - Stored LOCALLY: the keys below start with 'bccnc-' (NOT 'bcc-'),
   *    so the localStorage->Cosmos sync hook ignores them. Notifications
   *    are therefore per-device / per-user, never shared tenant-wide.
   *  - A 60s poller scans the (already synced) session/event docs for
   *    24h + 15min reminders, and member chat channels for new messages,
   *    raising: a center entry + unread badge, a toast (tab visible), and
   *    an OS notification (permission granted + tab hidden).
   * ==================================================================== */

  // Can the given user see a chat channel? Channels with no members[] are
  // "open" (visible to everyone, back-compat with the default seeded set);
  // channels with a members[] array are private to those upns (+ admins).
  window.bccChatCanSee = function (ch, upn) {
    if (!ch) return false;
    if (!Array.isArray(ch.members)) return true;
    if (window.bccIsAdmin && window.bccIsAdmin()) return true;
    var me = String(upn || (user && user.userDetails) || '').toLowerCase();
    return ch.members.some(function (m) { return String(m).toLowerCase() === me; });
  };

  var NC_KEY      = 'bccnc-items-v1';
  var NC_FIRED    = 'bccnc-fired-v1';
  var NC_CHATSEEN = 'bccnc-chatseen-v1';
  var NC_MAX      = 60;
  var DAY_MS      = 24 * 60 * 60 * 1000;
  var MIN15_MS    = 15 * 60 * 1000;
  var _ncPollStarted = false;

  function ncLoad()    { try { return JSON.parse(localStorage.getItem(NC_KEY)) || []; } catch (e) { return []; } }
  function ncSave(a)   { try { localStorage.setItem(NC_KEY, JSON.stringify(a.slice(0, NC_MAX))); } catch (e) {} }
  function ncFired()   { try { return JSON.parse(localStorage.getItem(NC_FIRED)) || {}; } catch (e) { return {}; } }
  function ncFiredSave(o) { try { localStorage.setItem(NC_FIRED, JSON.stringify(o)); } catch (e) {} }
  function ncUnread()  { return ncLoad().filter(function (i) { return !i.read; }).length; }
  function ncMyUpn()   { return String((user && user.userDetails) || '').toLowerCase(); }

  function ncBadge() {
    var b = document.getElementById('bcc-bell-badge');
    if (!b) return;
    var n = ncUnread();
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = 'flex'; }
    else b.style.display = 'none';
  }

  // Only allow same-origin relative paths or http(s) URLs as a notification target
  // (blocks javascript:/data: and attribute-breakout, since url is user-derived).
  function ncSafeUrl(u) {
    u = String(u || '');
    if (/^\/(?!\/)/.test(u)) return u;        // "/path" but not "//host"
    if (/^https?:\/\//i.test(u)) return u;
    return '';
  }
  function ncAdd(item) {
    if (!item || !item.title) return;
    var list = ncLoad();
    var tag = item.tag || '';
    if (tag && list.some(function (i) { return i.tag === tag; })) return false; // collapse dups
    var rec = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
      type: item.type || 'info',
      title: String(item.title).slice(0, 120),
      body: String(item.body || '').slice(0, 200),
      url: ncSafeUrl(item.url),
      tag: tag,
      at: Date.now(),
      read: false
    };
    list.unshift(rec);
    ncSave(list);
    ncBadge();
    ncRenderPanel();
    try {
      if (!document.hidden && window.bccNotify) {
        window.bccNotify(rec.title + (rec.body ? ' — ' + rec.body : ''), 'info', 6000);
      }
      if (('Notification' in window) && Notification.permission === 'granted' && document.hidden) {
        var n = new Notification(rec.title, { body: rec.body, icon: '/bcc-logo.png', tag: rec.tag || rec.id });
        n.onclick = function () { try { window.focus(); } catch (e) {} if (rec.url) location.href = rec.url; try { n.close(); } catch (e) {} };
      }
    } catch (e) {}
    return rec;
  }

  window.bccNotifyCenter = {
    add: ncAdd,
    list: ncLoad,
    unread: ncUnread,
    markAllRead: function () { var l = ncLoad(); l.forEach(function (i) { i.read = true; }); ncSave(l); ncBadge(); ncRenderPanel(); },
    clear: function () { ncSave([]); ncBadge(); ncRenderPanel(); }
  };

  function ncTimeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function ncFmtTime(t) {
    try { return new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function ncRenderPanel() {
    var list = document.getElementById('bcc-bell-list');
    if (!list) return;
    var items = ncLoad();
    if (!items.length) { list.innerHTML = '<div id="bcc-bell-empty">No notifications yet.</div>'; return; }
    list.innerHTML = items.map(function (i) {
      return '<a class="ni' + (i.read ? '' : ' unread') + '" data-id="' + i.id + '" href="' + escapeHtml(ncSafeUrl(i.url) || '#') + '">' +
        '<div class="t">' + escapeHtml(i.title) + '</div>' +
        (i.body ? '<div class="b">' + escapeHtml(i.body) + '</div>' : '') +
        '<div class="w">' + ncTimeAgo(i.at) + '</div></a>';
    }).join('');
    list.querySelectorAll('.ni').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var l = ncLoad(); var it = l.find(function (x) { return x.id === id; });
        if (it) { it.read = true; ncSave(l); ncBadge(); }
      });
    });
  }

  function ncMountBell() {
    if (!signedIn) return;
    var topbar = document.querySelector('header.topbar');
    if (!topbar || document.getElementById('bcc-bell')) return;

    if (!document.getElementById('bcc-bell-css')) {
      var st = document.createElement('style');
      st.id = 'bcc-bell-css';
      st.textContent = [
        '#bcc-bell{position:relative;background:rgba(255,255,255,0.12);border:none;color:#fff;width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}',
        '#bcc-bell:hover{background:rgba(255,255,255,0.22);}',
        '#bcc-bell-badge{position:absolute;top:-5px;right:-5px;background:#dc2626;color:#fff;font-size:9.5px;font-weight:800;line-height:1;min-width:16px;height:16px;border-radius:999px;display:none;align-items:center;justify-content:center;padding:0 4px;border:2px solid #1a1a1a;box-sizing:border-box;}',
        '#bcc-bell-panel{position:fixed;top:52px;right:12px;width:340px;max-width:calc(100vw - 24px);max-height:72vh;background:#fff;color:#1a1a1a;border:1px solid #e2e1dd;border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,0.28);z-index:9997;display:none;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}',
        '#bcc-bell-panel.open{display:flex;}',
        '#bcc-bell-panel .nch{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid #eee;}',
        '#bcc-bell-panel .nch strong{font-size:14px;color:#1a1a1a;}',
        '#bcc-bell-panel .nch button{background:none;border:none;color:#a8884a;font-size:11.5px;font-weight:700;cursor:pointer;padding:2px 4px;}',
        '#bcc-bell-list{overflow-y:auto;flex:1;}',
        '#bcc-bell-list .ni{display:block;padding:11px 14px;border-bottom:1px solid #f3f3f1;text-decoration:none;color:inherit;cursor:pointer;}',
        '#bcc-bell-list .ni:hover{background:#faf7f0;}',
        '#bcc-bell-list .ni.unread{background:#fbf6ec;}',
        '#bcc-bell-list .ni .t{font-weight:700;font-size:13px;color:#1a1a1a;}',
        '#bcc-bell-list .ni .b{font-size:12px;color:#6b685f;margin-top:2px;line-height:1.35;}',
        '#bcc-bell-list .ni .w{font-size:10.5px;color:#a8a79e;margin-top:3px;}',
        '#bcc-bell-empty{padding:26px 14px;text-align:center;color:#8a877e;font-size:13px;}',
        '#bcc-bell-foot{padding:10px 14px;border-top:1px solid #eee;}',
        '#bcc-bell-foot button{width:100%;padding:8px;border-radius:7px;border:1px solid #e2e1dd;background:#f8fafc;font-size:12px;font-weight:700;cursor:pointer;color:#1a1a1a;}',
        '#bcc-bell-foot button:hover{background:#eef0f3;}'
      ].join('');
      document.head.appendChild(st);
    }

    var bell = document.createElement('button');
    bell.id = 'bcc-bell';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'Notifications');
    bell.innerHTML = '🔔<span id="bcc-bell-badge"></span>';

    var chip = document.getElementById('bcc-auth-chip');
    var hamb = document.getElementById('bcc-hamburger');
    if (chip) chip.parentNode.insertBefore(bell, chip);
    else if (hamb) hamb.parentNode.insertBefore(bell, hamb);
    else topbar.appendChild(bell);

    var panel = document.createElement('div');
    panel.id = 'bcc-bell-panel';
    panel.innerHTML =
      '<div class="nch"><strong>Notifications</strong>' +
      '<div><button id="bcc-bell-readall">Mark all read</button>' +
      '<button id="bcc-bell-clear">Clear</button></div></div>' +
      '<div id="bcc-bell-list"></div>' +
      '<div id="bcc-bell-foot"><button id="bcc-bell-enable" type="button">Enable alerts on this device</button></div>';
    document.body.appendChild(panel);

    bell.onclick = function (e) {
      e.stopPropagation();
      // Recount on open: another tab may have added or read items since the last paint,
      // so the badge and the list it opens could disagree.
      if (panel.classList.toggle('open')) { ncBadge(); ncRenderPanel(); }
    };
    document.addEventListener('click', function (e) {
      if (panel.classList.contains('open') && !panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove('open');
    });
    var ra = document.getElementById('bcc-bell-readall');
    var cl = document.getElementById('bcc-bell-clear');
    var en = document.getElementById('bcc-bell-enable');
    if (ra) ra.onclick = function () { window.bccNotifyCenter.markAllRead(); };
    if (cl) cl.onclick = function () { window.bccNotifyCenter.clear(); };
    if (en) en.onclick = function () { if (window.bccEnablePush) window.bccEnablePush(); };

    ncBadge();
    ncRenderPanel();
  }

  function ncScanReminders() {
    var now = Date.now();
    var fired = ncFired();
    var changed = false;
    var myUpn = ncMyUpn();
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key) continue;
      var isSession = key.indexOf('bcc-session-') === 0;
      var isEvent = key.indexOf('bcc-event-') === 0;
      if (!isSession && !isEvent) continue;
      var doc; try { doc = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }
      if (!doc || !doc.startAt) continue;
      // A CANCELED session must not still page people. The server-side reminders cron
      // already skips these; the in-app bell did not, so the 24h and 15-minute reminders
      // kept firing for a session everyone had been told was off.
      var remStatus = String(doc.status || '').toLowerCase();
      if (remStatus === 'canceled' || remStatus === 'cancelled') continue;
      var t = Date.parse(doc.startAt);
      if (isNaN(t) || t <= now) continue;
      var remaining = t - now;
      if (remaining > DAY_MS) continue;
      // Sessions: only remind the assigned coach (when one is set).
      if (isSession && doc.coachUpn && String(doc.coachUpn).toLowerCase() !== myUpn) continue;
      var title = doc.title || (isSession ? 'Coaching session' : 'Event');
      var loc = doc.location ? ' · ' + doc.location : '';
      var kind, ntitle, body;
      if (remaining <= MIN15_MS) { kind = '15m'; ntitle = 'Starting soon: ' + title; body = 'Begins ' + ncFmtTime(t) + loc; }
      else                       { kind = 'day'; ntitle = 'Upcoming: ' + title;     body = 'Starts ' + ncFmtTime(t) + loc; }
      // Marker carries the START TIME, not just doc id + kind. It is pruned three
      // days after it fires, so an id-only key meant a session moved inside that
      // window kept the marker from its OLD time and its reminders were silently
      // suppressed at the new one. Keying on the parsed start makes a reschedule a
      // different marker, so it re-fires as it should — and because this is also
      // the ncAdd tag, the new time gets its own notification instead of being
      // collapsed into the stale one.
      var fkey = key + ':' + kind + ':' + t;
      if (fired[fkey]) continue;
      fired[fkey] = now; changed = true;
      ncAdd({ type: 'reminder', title: ntitle, body: body, url: (isSession ? '/sessions.html' : '/events.html'), tag: fkey });
    }
    Object.keys(fired).forEach(function (k) { if (now - fired[k] > 3 * DAY_MS) { delete fired[k]; changed = true; } });
    if (changed) ncFiredSave(fired);
  }

  function ncScanChat() {
    var here = (location.pathname.split('/').pop() || '').toLowerCase();
    if (here === 'chat.html') return; // they see messages live there
    var chans, msgs, read, seen;
    try { chans = JSON.parse(localStorage.getItem('bcc-chat-channels-v1')) || []; } catch (e) { return; }
    try { msgs  = JSON.parse(localStorage.getItem('bcc-chat-messages-v1')) || {}; } catch (e) { msgs = {}; }
    // Chat read-state is PER USER now (chat.html readKey()) — it used to be one
    // tenant-wide doc, so whoever opened a channel first cleared everyone's unread
    // badge. Read the caller's own doc, falling back to the retired shared key so the
    // bell doesn't announce every existing message as new on the first load after
    // this ships.
    var _ncReadKey = ncMyUpn() ? ('bcc-chat-last-read-' + ncMyUpn() + '-v1') : '';
    try {
      read = (_ncReadKey && JSON.parse(localStorage.getItem(_ncReadKey)))
          || JSON.parse(localStorage.getItem('bcc-chat-last-read-v1'))
          || {};
    } catch (e) { read = {}; }
    try { seen  = JSON.parse(localStorage.getItem(NC_CHATSEEN)) || {}; } catch (e) { seen = {}; }
    var myUpn = ncMyUpn();
    var myName = ((window.bccDisplayName ? window.bccDisplayName(myUpn) : '') || '').toLowerCase();
    var changed = false;
    chans.forEach(function (ch) {
      if (!window.bccChatCanSee(ch, myUpn)) return;
      // Skip tombstones (chat.html marks a deleted message rather than removing it, so the
      // server-side merge cannot resurrect it) — the bell must not announce a deleted
      // message, nor take one as the baseline for "everything before this is read".
      /* OWN PROPERTY. A channel id colliding with an Object.prototype member — 'constructor',
          'toString', 'valueOf' — resolved to a FUNCTION here, .filter threw, and the sweep
          died: one badly-named channel silently killed every chat notification for the whole
          firm. chat.html fixed this with chanMsgs(); this was its twin. The same applies to
          seen[] and read[] below, which are indexed by the same id. */
      var _raw = Object.prototype.hasOwnProperty.call(msgs, ch.id) ? msgs[ch.id] : null;
      var arr = (Array.isArray(_raw) ? _raw : []).filter(function (m) { return m && !m.deleted; });
      if (!arr.length) return;
      if (!Object.prototype.hasOwnProperty.call(seen, ch.id) || seen[ch.id] == null) { seen[ch.id] = arr[arr.length - 1].at; changed = true; return; } // baseline
      var _seenAt = Object.prototype.hasOwnProperty.call(seen, ch.id) ? seen[ch.id] : 0;
      var _readAt = Object.prototype.hasOwnProperty.call(read, ch.id) ? read[ch.id] : 0;
      var floor = Math.max((typeof _seenAt === 'number' ? _seenAt : 0), (typeof _readAt === 'number' ? _readAt : 0));
      var fresh = arr.filter(function (m) {
        if (!m || m.at <= floor) return false;
        var a = String(m.author || '').toLowerCase();
        return a !== myUpn && a !== myName;
      });
      if (!fresh.length) return;
      var newest = fresh[fresh.length - 1];
      seen[ch.id] = newest.at; changed = true;
      var preview = String(newest.text || (newest.photo ? '📷 photo' : '')).slice(0, 80);
      ncAdd({
        type: 'chat',
        title: 'New message in #' + (ch.name || ch.id),
        body: (newest.author ? newest.author + ': ' : '') + preview,
        url: '/chat.html',
        tag: 'chat-' + ch.id + '-' + newest.at
      });
    });
    if (changed) { try { localStorage.setItem(NC_CHATSEEN, JSON.stringify(seen)); } catch (e) {} }
  }

  // ---- Deal / engagement change alerts (ADMINS ONLY) ----
  // Engagements are stored as bcc-engagement-* docs (board cards on jobs.html).
  // We track each doc's updatedAt locally; when it advances on another admin's
  // change, we raise a bell entry. The actor suppresses their own change via
  // window.bccMarkEngagementSeen() (called from jobs.html on save/drag).
  var NC_ENGSEEN = 'bccnc-engseen-v1';

  function ncEngSnapshot() {
    var snap = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('bcc-engagement-') !== 0) continue;
      var d; try { d = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
      if (d && d.id) snap[k] = { u: d.updatedAt || '', title: d.title || '(untitled)', stage: d.stage || '' };
    }
    return snap;
  }
  function ncEngSeen() { try { return JSON.parse(localStorage.getItem(NC_ENGSEEN)) || {}; } catch (e) { return {}; } }
  function ncEngSeenSave(o) { try { localStorage.setItem(NC_ENGSEEN, JSON.stringify(o)); } catch (e) {} }

  // Called by jobs.html right after the current user saves/moves an engagement,
  // so their own change is treated as already-seen and never self-notifies.
  window.bccMarkEngagementSeen = function (id) {
    var seen = ncEngSeen();
    if (!seen.__init) { var s = ncEngSnapshot(); seen = { __init: true }; Object.keys(s).forEach(function (k) { seen[k] = s[k].u; }); }
    try { var d = JSON.parse(localStorage.getItem(id)); if (d) seen[id] = d.updatedAt || ''; } catch (e) {}
    ncEngSeenSave(seen);
  };

  function ncScanEngagements() {
    if (!(window.bccIsAdmin && window.bccIsAdmin())) return; // admins only
    var snap = ncEngSnapshot();
    var seen = ncEngSeen();
    if (!seen.__init) { // first run: baseline silently
      var base = { __init: true };
      Object.keys(snap).forEach(function (k) { base[k] = snap[k].u; });
      ncEngSeenSave(base);
      return;
    }
    var changed = false;
    Object.keys(snap).forEach(function (k) {
      var cur = snap[k].u;
      if (seen[k] === cur) return;
      var isNew = !(k in seen);
      seen[k] = cur; changed = true;
      var stageLabel = snap[k].stage ? (snap[k].stage.charAt(0).toUpperCase() + snap[k].stage.slice(1)) : '';
      ncAdd({
        type: 'deal',
        title: (isNew ? 'New deal: ' : 'Deal updated: ') + snap[k].title,
        body: stageLabel ? ('Stage: ' + stageLabel) : 'Engagement changed',
        url: '/jobs.html',
        tag: 'eng-' + k + ':' + cur
      });
    });
    if (changed) ncEngSeenSave(seen);
  }

  /* A durable per-device record of which server notifications this device has already
     surfaced. It has to be separate from the bell's display list, because that list is NOT
     a delivery record: "Clear" empties it outright and ncSave() truncates it to NC_MAX.
     Once an item fell out of it, the server's 14-day window handed it straight back on the
     next 60s poll and it was re-badged and re-toasted — so Clear undid itself, forever.
     Its own key, NOT NC_FIRED: ncScanReminders prunes that object by age with no regard for
     key shape and would evict these on a different schedule. */
  var NC_SRVSEEN = 'bccnc-srvseen-v1';
  function ncSrvSeen() { try { return JSON.parse(localStorage.getItem(NC_SRVSEEN)) || {}; } catch (e) { return {}; } }
  function ncSrvSeenSave(o) { try { localStorage.setItem(NC_SRVSEEN, JSON.stringify(o)); } catch (e) {} }

  // Pull server-pushed per-user notifications (feedback landed / addressed, etc.)
  // into the bell, then mark them delivered so they aren't re-fetched.
  function ncScanServerNotifs() {
    if (!signedIn) return;
    fetch('/api/notifications', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.notifications) || !j.notifications.length) return;
        // The server now returns recent notifications regardless of read state, so every
        // one of the user's devices gets a chance to show them — previously whichever
        // device polled first marked them read and they never reached the others at all.
        // Only report back the ones THIS device actually surfaced (ncAdd collapses by tag
        // against the local store), so re-polling doesn't churn.
        var seen = ncSrvSeen(), now = Date.now(), ids = [], changed = false;
        j.notifications.forEach(function (n) {
          if (!n || !n.id || seen[n.id]) return;   // this device has already surfaced it
          seen[n.id] = now; changed = true;        // recorded BEFORE ncAdd, so a collapse still counts
          ncAdd({ type: 'info', title: n.title, body: n.body, url: n.url, tag: n.id });
          ids.push(n.id);
        });
        // Prune past the server's own 14-day window, with a day's margin — first-seen is
        // always at or after createdAt, so 15 days cannot drop one the server still returns.
        Object.keys(seen).forEach(function (k) { if (now - seen[k] > 15 * DAY_MS) { delete seen[k]; changed = true; } });
        if (changed) ncSrvSeenSave(seen);
        if (ids.length) fetch('/api/notifications', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) }).catch(function () {});
      })
      .catch(function () {});
  }
  function ncPoll() {
    if (!signedIn) return;
    try { ncScanReminders(); } catch (e) {}
    try { ncScanChat(); } catch (e) {}
    try { ncScanEngagements(); } catch (e) {}
    try { ncScanServerNotifs(); } catch (e) {}
  }

  function ncStartPoller() {
    ncMountBell();
    if (_ncPollStarted || !signedIn) return;
    _ncPollStarted = true;
    setTimeout(ncPoll, 3000);
    setInterval(ncPoll, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ncPoll(); });
    window.addEventListener('focus', ncPoll);
  }

  window.addEventListener('bcc-auth-ready', ncStartPoller);
  window.addEventListener('bcc-users-ready', ncMountBell);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runBootstrap);
  } else {
    runBootstrap();
  }
})();

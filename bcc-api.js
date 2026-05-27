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
  var user = null;
  var pending = new Map();
  var pushTimer = null;
  var _origSetItem = Storage.prototype.setItem;
  var _origRemoveItem = Storage.prototype.removeItem;

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

  /* ---------- hooks ---------- */
  Storage.prototype.setItem = function (key, value) {
    _origSetItem.call(this, key, value);
    if (this === window.localStorage && signedIn && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0) {
      pending.set(key, value);
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
    if (this === window.localStorage && signedIn && typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0) {
      pending.set(key, null); // null marks deletion
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

  async function flush() {
    if (!signedIn || pending.size === 0) return;
    var entries = Array.from(pending.entries());
    pending.clear();

    var puts = [];
    var deletes = [];
    entries.forEach(function (e) {
      if (permanentlyFailed.has(e[0])) return; // skip known-bad keys
      if (e[1] === null) deletes.push(e[0]);
      else {
        try { puts.push({ key: e[0], data: JSON.parse(e[1]) }); }
        catch { puts.push({ key: e[0], data: e[1] }); } // non-JSON value, store raw
      }
    });

    if (!puts.length && !deletes.length) {
      setSyncState('idle');
      return;
    }

    setSyncState('pushing');
    var putStatus = 0;
    try {
      if (puts.length) {
        const r = await fetch(API_BASE + '/data', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: puts })
        });
        putStatus = r.status;
        if (!r.ok) {
          // 4xx = client / permission error — permanent. Don't retry.
          // 5xx / network = transient — re-queue and retry.
          if (r.status >= 400 && r.status < 500) {
            puts.forEach(function (p) {
              permanentlyFailed.add(p.key);
              console.warn('[bcc-api] push refused (' + r.status + '), dropping key:', p.key);
              window.dispatchEvent(new CustomEvent('bcc-sync-error', {
                detail: { key: p.key, status: r.status }
              }));
            });
            setSyncState('error');
            return;
          }
          throw new Error('PUT failed ' + r.status);
        }
        // Audit: one entry per batch flush, listing the keys touched
        window.bccAudit && window.bccAudit('data-write', { meta: { keys: puts.map(function (p) { return p.key; }) } });
      }
      for (var i = 0; i < deletes.length; i++) {
        var dr = await fetch(API_BASE + '/data/' + encodeURIComponent(deletes[i]), { method: 'DELETE' });
        if (!dr.ok && dr.status >= 400 && dr.status < 500) {
          permanentlyFailed.add(deletes[i]);
          continue;
        }
        window.bccAudit && window.bccAudit('data-delete', { key: deletes[i] });
      }
      setSyncState('idle');
    } catch (err) {
      console.warn('[bcc-api] push failed (transient), re-queuing in 5s:', err);
      // Only re-queue items that aren't permanently failed
      entries.forEach(function (e) {
        if (!permanentlyFailed.has(e[0])) pending.set(e[0], e[1]);
      });
      setSyncState('error');
      setTimeout(flush, 5000);
    }
  }

  // Manually clear the permanent-failure set (admins call this after granting
  // the right role) and re-trigger a flush.
  window.bccRetrySync = function () {
    permanentlyFailed.clear();
    return flush();
  };

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
   *   global role 'member' (or anything else) -> 'edit' for every app
   * The admin page is an exception: it always requires effective 'admin'
   * unless the user.role is 'admin' (admins implicitly admin every app).
   *
   * To gate a page, call window.bccEnforcePagePermission(appKey, minLevel)
   * during page init. Returns the user's level. If the user lacks the level,
   * shows an access-denied overlay and freezes the page.
   */
  window.BCC_APP_KEYS = [
    'home','myday','sessions','crm','jobs','scheduler','marketing',
    'bookkeeping','documents','rates','chat','training','events','kb','admin'
  ];
  // Filename (with .html) -> app key. Used to map location.pathname to a key.
  window.BCC_PAGE_TO_APP = {
    '':              'home',
    'index.html':    'home',
    'myday.html':    'myday',
    'sessions.html': 'sessions',
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
  var LEVEL_RANK = { none: 0, view: 1, edit: 2, admin: 3 };
  function _adminCfg() {
    try { return JSON.parse(localStorage.getItem('bcc-admin-config-v1') || 'null'); } catch (e) { return null; }
  }
  function _findUserRec(upn) {
    var cfg = _adminCfg();
    if (!cfg || !cfg.users) return null;
    var lc = String(upn || '').toLowerCase();
    for (var i = 0; i < cfg.users.length; i++) {
      var u = cfg.users[i];
      if ((u.upn || '').toLowerCase() === lc) return u;
    }
    return null;
  }
  window.bccGetAppPermission = function (appKey, upn) {
    if (!appKey) return 'none';
    var who = upn || (window.bccUser && window.bccUser.userDetails) || '';
    if (!who) return 'none'; // anonymous -> no app permission
    var cfg = _adminCfg();
    var rec = _findUserRec(who);
    // Inactive users are blocked everywhere
    if (rec && rec.status === 'inactive') return 'none';
    // Per-app override wins if explicitly set
    var perm = rec && rec.appPermissions && rec.appPermissions[appKey];
    if (perm && LEVEL_RANK[perm] != null) return perm;
    // Fall back to global role
    var isAdmin = rec && rec.role === 'admin';
    if (isAdmin) return 'admin';
    if (appKey === 'admin') {
      // Strict gate: only admins reach the admin page. Delegates to
      // bccIsAdmin() which honors the same recovery paths the server
      // uses (BCC_OWNER_UPNS env list, SWA 'administrator' role,
      // server's /api/profile verdict). The narrow bootstrap inside
      // bccIsAdmin() only triggers on a truly empty admin-config doc
      // (first deploy) -- once anyone exists in cfg.users, admin role
      // is required.
      return (window.bccIsAdmin && window.bccIsAdmin()) ? 'admin' : 'none';
    }
    return 'edit';
  };
  window.bccCanAccess = function (appKey, upn) {
    return LEVEL_RANK[window.bccGetAppPermission(appKey, upn)] >= LEVEL_RANK.view;
  };
  window.bccCanEdit = function (appKey, upn) {
    return LEVEL_RANK[window.bccGetAppPermission(appKey, upn)] >= LEVEL_RANK.edit;
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
      '<div style="color:rgba(255,255,255,0.7);max-width:420px;line-height:1.5;font-size:14px;">Your account doesn\'t have permission to open <strong>' + label + '</strong>. Ask an admin in Admin &rsaquo; Users &amp; Roles to grant access.</div>' +
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
    try {
      var r = await fetch('/.auth/me', { credentials: 'include' });
      if (r.ok) {
        var j = await r.json();
        user = j && j.clientPrincipal ? j.clientPrincipal : null;
        signedIn = !!user;
      }
    } catch (e) {
      // not deployed on SWA, or network issue — anon mode
    }

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
      var dataPromise = fetch(API_BASE + '/data').catch(function (e) {
        console.warn('[bcc-api] initial pull failed', e);
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
          (j.items || []).forEach(function (it) {
            if (it && it.key && it.data !== undefined) {
              if (pending.has(it.key)) return; // user has a newer local write queued
              var val = typeof it.data === 'string' ? it.data : JSON.stringify(it.data);
              _origSetItem.call(localStorage, it.key, val);
            }
          });
        }
      } catch (e) {
        console.warn('[bcc-api] initial pull failed', e);
      }

      // 3) Auto-populate bcc-field-who from the signed-in identity if not set
      if (user && user.userDetails && !localStorage.getItem('bcc-field-who')) {
        _origSetItem.call(localStorage, 'bcc-field-who', user.userDetails);
      }

      // 4) Pull active Entra users. The fetch was kicked off in parallel
      //    with /api/data above; we just need to await its already-running
      //    promise here. Two exports:
      //   window.bccPeopleFull -> every active Entra user (admin uses this so it
      //     can show & manage all of them, including ones marked Inactive in app)
      //   window.bccPeople     -> display names, FILTERED to exclude users marked
      //     Inactive in bcc-admin-config-v1. This is what every dropdown uses.
      try {
        var ur = await usersPromise;
        if (ur && ur.ok) {
          var uj = await ur.json();
          var live = (uj.users || []).filter(function (u) { return u && u.displayName; });
          window.bccPeopleFull = live;
          recomputePcPeople();
        }
      } catch (e) {
        console.warn('[bcc-api] users response parse failed', e);
      }
    }

    injectAuthChip();
    finishProgress();

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

    window.dispatchEvent(new Event('bcc-auth-ready'));
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
  function injectAuthChip() {
    if (document.getElementById('bcc-auth-chip')) return;
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
      '.bcc-offline{position:fixed;top:0;left:0;right:0;z-index:9997;background:#a16207;color:#fff;padding:8px 14px;font-size:13px;font-weight:700;text-align:center;display:none;}' +
      '.bcc-offline.show{display:block;}' +
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
      '.bcc-auth-chip{display:inline-flex;align-items:center;gap:6px;color:rgba(255,255,255,0.72);font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.06);}' +
      '.bcc-auth-chip .bcc-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0;}' +
      '.bcc-auth-chip.anon .bcc-dot{background:#6b685f;}' +
      '.bcc-auth-chip.syncing .bcc-dot{background:#f59e0b;animation:bccPulse 1s infinite;}' +
      '.bcc-auth-chip.error .bcc-dot{background:#7a4848;}' +
      '@keyframes bccPulse{0%{opacity:0.4;}50%{opacity:1;}100%{opacity:0.4;}}' +
      '.bcc-auth-chip .bcc-name{color:#fff;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.bcc-auth-chip a{color:rgba(255,255,255,0.72);text-decoration:none;font-size:12px;white-space:nowrap;}' +
      '.bcc-auth-chip a:hover{color:#fff;}' +
      // Single unified menu pattern — same on every viewport. Per-page inline
      // <a class="nav-link"> elements are hidden so the topbar stays clean.
      'header.topbar{position:relative;flex-wrap:nowrap;}' +
      'header.topbar > a.nav-link{display:none !important;}' +
      // Hamburger button — always visible, lives on the right side of topbar.
      '.bcc-hamburger{display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.12);border:none;color:#fff;width:40px;height:40px;border-radius:9px;cursor:pointer;font-size:20px;flex-shrink:0;padding:0;line-height:1;transition:background 0.15s;}' +
      '.bcc-hamburger:hover{background:rgba(255,255,255,0.20);}' +
      '.bcc-hamburger.open{background:rgba(255,255,255,0.20);}' +
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
      var skipTarget = document.querySelector('main, .wrap, .app, .board, .grid-wrap');
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

      // Footer: sign in/out action
      html += '<div class="bcc-mm-foot">';
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

  /* ---------- Offline-aware save toast ----------
   * window.bccNotifySaved(onlineMsg)
   *   Online  → success toast with onlineMsg
   *   Offline → warn toast: "Saved locally — will sync when reconnected"
   * Form submit handlers (tm/trucking/hydrant/inspections) call this
   * instead of bccNotify directly so the message tells the truth.
   */
  window.bccNotifySaved = function (onlineMsg, ttl) {
    if (!window.bccNotify) { try { alert(onlineMsg); } catch (e) {} return; }
    if (navigator.onLine) {
      window.bccNotify(onlineMsg || 'Saved.', 'success', ttl);
    } else {
      window.bccNotify((onlineMsg ? onlineMsg + ' ' : '') + 'Saved locally — will sync when reconnected.', 'warn', ttl || 5000);
    }
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
    bar.classList.add('show');
  }
  window.addEventListener('online',  refreshOnlineState);
  window.addEventListener('offline', refreshOnlineState);
  // Defer the first check until DOM is ready so we can append to <body>.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshOnlineState);
  } else {
    refreshOnlineState();
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
      if (!cfg) return true;                           // no config yet (first deploy)
      var users = Array.isArray(cfg.users) ? cfg.users : [];
      if (!users.length) return true;                  // empty list (cloud hasn't synced)
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
      if (existing) {
        // Re-post the existing subscription so the server has a fresh row
        // for this user even if the cookie / UPN context changed.
        try { existing = await reg.pushManager.getSubscription(); } catch (_) {}
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();

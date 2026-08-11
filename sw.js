/*
 * BCC Connect — Service Worker
 *
 * Goal: the four field-form pages (T&M, Trucking Slip, Fire Hydrant,
 * Inspections) must load and work when the device has no network.
 *
 * Strategy:
 *   - Pre-cache the form pages + bcc-api.js + logos at install time so
 *     they're available offline from the very first SW activation.
 *   - Network-first on every fetch (so online users ALWAYS see the
 *     latest deployed code — no risk of stale-cache lockout). Falls
 *     back to cache only when fetch fails.
 *   - Cache-first only for images, where freshness doesn't matter.
 *   - Never intercept /api/* or /.auth/* — those are dynamic and any
 *     caching of them would break sync / auth.
 *
 * Submission flow when offline is already handled by bcc-api.js:
 *   localStorage write → debounced push to /api/data → if push fails,
 *   the entry stays queued and retries every 5 s (plus immediately on
 *   the next 'online' event). Cosmos receives the data the moment
 *   network returns. The user just sees a "Saved locally — will sync"
 *   toast instead of "Submitted to office".
 */

/* Bump this whenever a cached ASSET changes. The activate handler deletes every cache
   whose name differs, so a bump is what actually evicts the old copies — and the image
   branch below is cache-first with no revalidation, so without a bump a replaced logo or
   icon is served from this cache forever, on every device that ever loaded the old one.
   Date-stamped rather than numbered so it is obvious when it was last rolled. */
const CACHE_NAME = 'bcc-offline-2026-08-11';

// Pages the user explicitly wants offline-capable. BCC doesn't have field
// crews on remote sites, so this is light — just the dashboard + the
// highest-traffic coaching workflow pages.
const OFFLINE_PAGES = [
  '/',
  '/index.html',
  '/myday.html',
  '/scheduler.html',
  '/crm.html',
  '/sessions.html'
];

// Shared dependencies that every page loads.
const STATIC_ASSETS = [
  '/bcc-api.js',
  '/bcc-logo.png',
  '/bcc-logo-large.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Per-URL add so a single 404 / 302 (e.g. unauth at install time)
    // doesn't tear down the whole pre-cache.
    await Promise.all([...OFFLINE_PAGES, ...STATIC_ASSETS].map((url) =>
      cache.add(new Request(url, { credentials: 'include' }))
        .catch((e) => { /* swallow — best-effort precache */ })
    ));
    // Activate immediately so the user gets offline support on the
    // very first page after registration.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any caches that aren't the current version (cleans up after we bump
    // CACHE_NAME). But ONLY once the new cache actually has something in it: install
    // swallows every per-URL failure, so a bump applied while the user is signed out (or
    // briefly offline) can produce an EMPTY new cache — and evicting the old one then
    // leaves the device with no offline copies at all, which is strictly worse than
    // holding a slightly stale set. The stale caches get dropped on the next activate
    // that succeeds.
    const cache = await caches.open(CACHE_NAME);
    const filled = (await cache.keys()).length;
    if (filled > 0) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }
    // Take control of any tabs that were open before this SW activated.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;          // never cache mutations
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // cross-origin: let browser handle
  if (url.pathname.startsWith('/api/'))   return;    // API: never cache
  if (url.pathname.startsWith('/.auth/')) return;    // SWA auth flow: bypass entirely

  // Network-first for HTML / JS / CSS. Updates the cache on every
  // successful response, so users keep getting fresh code while
  // online. Falls back to whatever's cached if the network fails.
  const isHtml   = req.destination === 'document' || url.pathname.endsWith('.html');
  const isScript = req.destination === 'script'   || url.pathname.endsWith('.js');
  const isStyle  = req.destination === 'style'    || url.pathname.endsWith('.css');
  if (isHtml || isScript || isStyle || url.pathname === '/' || url.pathname === '/manifest.json') {
    event.respondWith((async () => {
      try {
        const r = await fetch(req);
        // Only cache valid (200, basic) responses to avoid storing
        // auth redirects (302→/login) or errors.
        if (r && r.ok && r.type === 'basic') {
          const clone = r.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
        }
        return r;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Last-resort fallback for unknown HTML routes when offline.
        if (isHtml) {
          const fb = (await caches.match('/myday.html'))
                  || (await caches.match('/index.html'))
                  || (await caches.match('/'));
          if (fb) return fb;
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
          '<body style="font:14px/1.5 system-ui;padding:30px;color:#1a1a1a;background:#f6f6f4">' +
          '<h2>You are offline</h2><p>This page hasn\'t been cached for offline use yet. Reconnect and try again.</p></body>',
          { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // Cache-first for images — they rarely change and we don't want
  // every page repainting to hit the network.
  if (req.destination === 'image') {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      // Serve the cached copy immediately, but refresh it in the background so a replaced
      // image reaches this device on the NEXT load rather than never (the cache had no
      // revalidation at all, and CACHE_NAME had never been bumped).
      if (cached) {
        fetch(req).then((r) => {
          if (r && r.ok && r.type === 'basic' && r.status === 200) caches.open(CACHE_NAME).then((c) => c.put(req, r.clone())).catch(() => {});
        }).catch(() => {});
        return cached;
      }
      try {
        const r = await fetch(req);
        // r.ok already excludes 4xx/5xx; type 'basic' excludes opaque cross-origin. A 206
        // partial must never be cached — Cache.put rejects it, but be explicit.
        if (r && r.ok && r.type === 'basic' && r.status === 200) {
          const clone = r.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
        }
        return r;
      } catch (e) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else: just fetch normally.
});

/* Message channel — bcc-api.js can post {type:'kill'} to nuke all caches
 * and unregister the SW if we ever need a remote kill switch (e.g. a
 * future deploy that has to clear a corrupted cache state). */
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'kill') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
    })());
  }
});

/* ============ Push notifications (additive) ============
 * Server sends { title, body, url, tag } as JSON. We display a system
 * notification; clicking it focuses an open tab for that URL if one
 * exists, otherwise opens a new tab.
 *
 * Wrapped in try/catch + getter helpers so a malformed payload can
 * never break the existing offline cache behavior.
 */
/* A push subscription can be rotated or invalidated by the browser at any time (storage
   pressure, a permission reset, a push-service change). Nothing re-registered it, so push
   simply stopped working on that device forever, with no signal to the user and a row in
   Cosmos still pointing at the dead endpoint. Re-subscribe with the CURRENT server key —
   sw.js holds no VAPID key of its own, so fetch it — and hand the new subscription to the
   same endpoint the page uses. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!key) {
        const r = await fetch('/api/push-public-key');
        if (!r.ok) return;
        const j = await r.json();
        if (!j || !j.publicKey) return;
        const b64 = (j.publicKey + '='.repeat((4 - (j.publicKey.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64);
        key = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
      }
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      // credentials:'include' so the SWA auth cookie rides along — without it the server
      // cannot tell whose device this is and the row would be orphaned.
      await fetch('/api/push-subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub })
      });
      // Retire the dead endpoint so it stops being pushed to.
      if (event.oldSubscription && event.oldSubscription.endpoint) {
        await fetch('/api/push-subscribe?endpoint=' + encodeURIComponent(event.oldSubscription.endpoint), { method: 'DELETE', credentials: 'include' }).catch(() => {});
      }
    } catch (e) { /* best-effort: a failed re-subscribe must never break the SW */ }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    try { data = { title: 'BCC Connect', body: event.data && event.data.text() || '' }; } catch (_) { data = {}; }
  }
  const title = data.title || 'BCC Connect';
  const opts = {
    body: data.body || '',
    icon: '/bcc-logo.png',
    badge: '/bcc-logo.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer focusing an existing tab on the same path (with or without
    // the ?id= param). Otherwise open a new window.
    const targetPath = target.split('?')[0];
    for (const client of all) {
      try {
        const clientPath = new URL(client.url).pathname;
        if (clientPath === targetPath && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(target); } catch (_) {}
          }
          return;
        }
      } catch (_) { /* ignore */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});

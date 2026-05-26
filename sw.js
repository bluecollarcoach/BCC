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

const CACHE_NAME = 'bcc-offline-v1';

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
    // Drop any caches that aren't the current version (cleans up after
    // we bump CACHE_NAME on future updates).
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
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
          '<body style="font:14px/1.5 system-ui;padding:30px;color:#1a1a1a;background:#f1f5f9">' +
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
      if (cached) return cached;
      try {
        const r = await fetch(req);
        if (r && r.ok && r.type === 'basic') {
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

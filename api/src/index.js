// BCC Connect API — Azure Functions v4 programming model.
// Endpoints (all gated by Static Web Apps Entra ID auth via staticwebapp.config.json):
//   GET    /api/data            -> list every bcc-* doc for the tenant
//   GET    /api/data/{key}      -> one doc
//   PUT    /api/data            -> body: { items: [{key,data}, ...] } OR { key, data }
//   PUT    /api/data/{key}      -> body is the data object directly
//   DELETE /api/data/{key}      -> remove one doc
//   GET    /api/profile         -> current SWA principal (or null)
//   GET    /api/users           -> active Entra users (Microsoft Graph, client-credentials)

const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

/* ============ web-push (lazy require) ============
 * web-push is an optional dependency: if VAPID env vars aren't set
 * (e.g. local dev) we skip all push fan-out and the rest of the API
 * keeps working exactly as before. The require is wrapped in try/catch
 * so even a broken install can't crash the cold-start.
 */
let _webpush = null;
function getWebPush() {
  if (_webpush) return _webpush;
  try {
    const wp = require('web-push');
    const pub  = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subj = process.env.VAPID_SUBJECT || 'mailto:admin@bluecollarcoach.us';
    if (!pub || !priv) return null;
    wp.setVapidDetails(subj, pub, priv);
    _webpush = wp;
    return wp;
  } catch (e) {
    return null;
  }
}

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY      = process.env.COSMOS_KEY;
const COSMOS_DB       = process.env.COSMOS_DB || 'bcc-connect';
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || 'data';
const BCC_TENANT_ID    = process.env.BCC_TENANT_ID || 'blue-collar-coach';
const ADMIN_KEYS      = new Set(['bcc-admin-config-v1']); // writable only by users with 'administrator' role

let _container = null;
function container() {
  if (!_container) {
    if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
      throw new Error('COSMOS_ENDPOINT and COSMOS_KEY app settings are required');
    }
    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    _container = client.database(COSMOS_DB).container(COSMOS_CONTAINER);
  }
  return _container;
}

function principal(req) {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { return null; }
}

// SWA's auth config pins the Entra openIdIssuer to BCC's tenant GUID, so
// only tenant members can authenticate at all. Extra string-match on
// userDetails causes false 403s when SWA returns a privacy-masked userDetails.
// Allow any authenticated principal; finer privilege is enforced via the
// admin role check + BCC_OWNER_UPNS env var below.
function domainAllowed(p) {
  return !!p;
}

function hasRole(p, role) {
  return p && Array.isArray(p.userRoles) && p.userRoles.includes(role);
}

/* ============ App-managed admin check ============
 * Source of truth: bcc-admin-config-v1.users[].role === 'admin' (and status
 * not 'inactive'). Plus an env-based bootstrap list (BCC_OWNER_UPNS) for
 * the owner accounts that can never be locked out.
 *
 * Bootstrap rule: if no admin config exists yet, OR the existing config
 * has zero active admins, ANY authenticated BCC-domain user can
 * save once (and is expected to set themselves as an admin in that save).
 * This keeps the app self-bootstrapping — no Azure portal trip required
 * after deployment.
 *
 * Cached for 15 s per Function instance because every admin-write reads
 * the doc. Invalidated immediately whenever we successfully write
 * bcc-admin-config-v1.
 */
let _adminCfgCache = null;
async function getAdminCfg() {
  if (_adminCfgCache && Date.now() < _adminCfgCache.expires) return _adminCfgCache.data;
  try {
    const { resource } = await container().item('bcc-admin-config-v1', BCC_TENANT_ID).read();
    const data = resource && resource.data;
    _adminCfgCache = { data: data || null, expires: Date.now() + 15000 };
    return _adminCfgCache.data;
  } catch (e) {
    if (e.code === 404) {
      _adminCfgCache = { data: null, expires: Date.now() + 15000 };
      return null;
    }
    throw e;
  }
}
function invalidateAdminCfgCache() { _adminCfgCache = null; }

function bootstrapOwners() {
  return String(process.env.BCC_OWNER_UPNS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

async function isAppAdmin(p) {
  if (!p || !p.userDetails) return false;
  const who = String(p.userDetails).toLowerCase();

  // 1) Env-configured owner accounts are always admin (recovery accounts)
  if (bootstrapOwners().includes(who)) return true;

  // 2) Legacy: anyone with the SWA 'administrator' role keeps admin access
  //    (so existing portal-invited admins don't lose access during migration)
  if (hasRole(p, 'administrator')) return true;

  // 3) App-level admin config. Bootstrap ONLY when the config is missing
  //    or completely empty — once any users exist in the config (even
  //    non-admins), admin role is required. Closes the "no admins set →
  //    everyone is admin" loophole. Recovery is via BCC_OWNER_UPNS or the
  //    SWA 'administrator' role above.
  const cfg = await getAdminCfg();
  if (!cfg) return true;                         // no doc yet → first save wins
  const users = Array.isArray(cfg.users) ? cfg.users : [];
  if (!users.length) return true;                // truly empty → bootstrap
  return users.some(u =>
    u && u.role === 'admin' && u.status !== 'inactive' && (
      (u.upn   || '').toLowerCase() === who ||
      (u.email || '').toLowerCase() === who
    )
  );
}

function isPcKey(k) {
  return typeof k === 'string' && k.startsWith('bcc-') && k.length < 80;
}

function badRequest(msg) { return { status: 400, jsonBody: { error: msg } }; }
function unauthorized()  { return { status: 401, jsonBody: { error: 'unauthenticated' } }; }
function forbidden(msg)  { return { status: 403, jsonBody: { error: msg || 'forbidden' } }; }
function domainBlocked() { return { status: 403, jsonBody: { error: 'domain_not_allowed', detail: 'sign in with an @bluecollarcoach.us account' } }; }

function getClientIp(req) {
  const xff = req.headers.get('x-forwarded-for') || '';
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-azure-clientip')
      || req.headers.get('x-real-ip')
      || '';
}

/* ============ Access log ============
 * One Cosmos doc per /api/* HTTP request, separate docType from 'audit'
 * (which is for client-side semantic events). The Falcon-style activity
 * table reads both. Fire-and-forget — never blocks the response, never
 * propagates failures.
 *
 * We skip our own access-log writes to /api/audit GET so the activity
 * log isn't constantly logging itself.
 */
function logAccess(request, response, p) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/api/audit') return; // don't log the log
    const status = (response && response.status) || (response && response.jsonBody ? 200 : 200);
    const c = container();
    const ts = new Date().toISOString();
    const id = 'access-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const doc = {
      id,
      tenantId: BCC_TENANT_ID,
      docType: 'access',
      ts,
      method: request.method,
      path,
      status,
      user: (p && (p.userDetails || p.userId)) || null,
      ip: getClientIp(request),
      userAgent: String(request.headers.get('user-agent') || '').slice(0, 200)
    };
    // Fire-and-forget; if Cosmos write fails, swallow.
    c.items.create(doc).catch(() => {});
  } catch (e) { /* swallow */ }
}

// Wrap an Azure Functions handler so every invocation is access-logged.
function withAccessLog(handler) {
  return async (request, context) => {
    let response;
    try {
      response = await handler(request, context);
    } catch (err) {
      context.error && context.error('handler error', err);
      response = { status: 500, jsonBody: { error: 'server error', detail: String(err && err.message || err) } };
    }
    // Resolve a principal AFTER the handler runs, so even unauthenticated
    // requests get logged with user:null and status:401.
    let p = null;
    try { p = principal(request); } catch (e) {}
    logAccess(request, response, p);
    return response;
  };
}

app.http('data', {
  methods: ['GET', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'data/{key?}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();

    const c = container();
    const key = request.params.key || null;
    const method = request.method;

    try {
      if (method === 'GET') {
        if (key) {
          if (!isPcKey(key)) return badRequest('invalid key');
          try {
            const { resource } = await c.item(key, BCC_TENANT_ID).read();
            return { jsonBody: { key, data: resource ? resource.data : null, updatedAt: resource && resource.updatedAt, updatedBy: resource && resource.updatedBy } };
          } catch (e) {
            if (e.code === 404) return { jsonBody: { key, data: null } };
            throw e;
          }
        }
        const q = {
          query: 'SELECT c.id, c.data, c.updatedAt, c.updatedBy FROM c WHERE c.tenantId = @t AND STARTSWITH(c.id, "bcc-")',
          parameters: [{ name: '@t', value: BCC_TENANT_ID }]
        };
        const { resources } = await c.items.query(q).fetchAll();
        return { jsonBody: { items: resources.map(r => ({ key: r.id, data: r.data, updatedAt: r.updatedAt, updatedBy: r.updatedBy })) } };
      }

      if (method === 'PUT') {
        const body = await request.json().catch(() => ({}));
        let items;
        if (Array.isArray(body.items)) items = body.items;
        else if (key) items = [{ key, data: body.data !== undefined ? body.data : body }];
        else if (body.key) items = [{ key: body.key, data: body.data }];
        else return badRequest('expected { key, data } or { items: [...] }');

        let touchesAdminKey = false;
        for (const it of items) {
          if (!isPcKey(it.key)) return badRequest('invalid key: ' + it.key);
          if (ADMIN_KEYS.has(it.key)) touchesAdminKey = true;
        }
        if (touchesAdminKey && !(await isAppAdmin(p))) {
          return forbidden('only administrators may write admin config');
        }
        const now = new Date().toISOString();
        const who = p.userDetails || p.userId || 'unknown';
        for (const it of items) {
          await c.items.upsert({
            id: it.key,
            tenantId: BCC_TENANT_ID,
            data: it.data,
            updatedAt: now,
            updatedBy: who
          });
        }
        // Whenever bcc-admin-config-v1 changes, drop our cache so the next
        // admin check sees the new user/role list immediately (otherwise an
        // admin demotion could take up to 15 s to take effect).
        if (touchesAdminKey) invalidateAdminCfgCache();
        return { status: 204 };
      }

      if (method === 'DELETE') {
        if (!key) return badRequest('key required');
        if (!isPcKey(key)) return badRequest('invalid key');
        if (ADMIN_KEYS.has(key) && !(await isAppAdmin(p))) return forbidden();
        try { await c.item(key, BCC_TENANT_ID).delete(); } catch (e) { if (e.code !== 404) throw e; }
        if (ADMIN_KEYS.has(key)) invalidateAdminCfgCache();
        return { status: 204 };
      }
    } catch (err) {
      context.error('data handler error', err);
      return { status: 500, jsonBody: { error: 'server error', detail: String(err && err.message || err) } };
    }
  })
});

app.http('profile', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return { jsonBody: null };
    // Attach a server-computed admin verdict so the client UI can
    // honor the same recovery paths the server uses (BCC_OWNER_UPNS,
    // SWA 'administrator' role) without duplicating that logic
    // client-side. Field is added without modifying the original
    // principal shape so existing consumers keep working.
    let isAdmin = false;
    try { isAdmin = await isAppAdmin(p); } catch (e) { isAdmin = false; }
    return { jsonBody: Object.assign({}, p, { isAppAdmin: isAdmin }) };
  })
});

/* ============ /api/users — active Entra users via Microsoft Graph ============
 * Uses client-credentials with the same AZURE_TENANT_ID / AZURE_CLIENT_ID /
 * AZURE_CLIENT_SECRET that SWA uses for sign-in. The Entra app registration
 * needs Microsoft Graph "User.Read.All" Application permission + admin consent.
 *
 * Caches the token (~1h) and the user list (5 min) per Function instance to
 * keep latency low and Graph happy.
 */
const AZURE_TENANT_ID    = process.env.AZURE_TENANT_ID;
const AZURE_CLIENT_ID    = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

let _tokenCache = null;   // { token, expiresAt }
let _usersCache = null;   // { users, expiresAt }
const USERS_TTL_MS = 5 * 60 * 1000;

async function getGraphToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) return _tokenCache.token;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error('AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET app settings required');
  }
  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('token endpoint ' + r.status + ': ' + (await r.text()));
  const j = await r.json();
  _tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in * 1000) };
  return j.access_token;
}

function userInAllowedDomain(u) {
  if (!u) return false;
  const candidates = [u.userPrincipalName, u.mail].filter(Boolean).map(s => String(s).toLowerCase());
  if (candidates.length === 0) return false;
  return candidates.some(c => ALLOWED_DOMAINS.some(d => c.endsWith('@' + d)));
}

async function fetchActiveUsers() {
  if (_usersCache && _usersCache.expiresAt > Date.now()) return _usersCache.users;
  const token = await getGraphToken();
  const select = '$select=id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,accountEnabled,department,userType';
  const filter = '$filter=accountEnabled eq true';
  const top    = '$top=200';
  const url    = `https://graph.microsoft.com/v1.0/users?${select}&${filter}&${top}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('Graph users ' + r.status + ': ' + (await r.text()));
  const j = await r.json();
  const users = (j.value || [])
    .filter(u => u.accountEnabled !== false)
    // Domain allowlist: drop guests / external accounts so they never reach a dropdown.
    .filter(userInAllowedDomain)
    // Also drop Microsoft service / guest userTypes if present
    .filter(u => !u.userType || String(u.userType).toLowerCase() === 'member')
    .map(u => ({
      id: u.id,
      displayName: u.displayName,
      givenName: u.givenName || null,
      surname: u.surname || null,
      mail: u.mail || null,
      upn: u.userPrincipalName || null,
      jobTitle: u.jobTitle || null,
      department: u.department || null
    }))
    .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  _usersCache = { users, expiresAt: Date.now() + USERS_TTL_MS };
  return users;
}

/* ============ /api/audit — user activity log ============
 * Stores one Cosmos doc per user action. Same container as bcc-* docs but
 * partitioned the same way (by tenantId) with id prefix "audit-".
 *
 * POST /api/audit  { action, path?, key?, meta? }
 *   Server fills in: user (from SWA principal), ip (from X-Forwarded-For),
 *   userAgent, ts. Body fields are optional context.
 *
 * GET  /api/audit?limit=200&since=ISO
 *   Returns most-recent audit events. Auth-gated. No admin role required —
 *   the activity password gate is what guards display (per spec).
 */
function clientIp(req) {
  // Azure SWA / Front Door chain: X-Forwarded-For is "client, proxy1, proxy2"
  const xff = req.headers.get('x-forwarded-for') || '';
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-azure-clientip')
      || req.headers.get('x-real-ip')
      || '';
}

const ALLOWED_AUDIT_ACTIONS = new Set([
  // Identity / access
  'signin', 'signin-denied', 'signout',
  'page-view',
  // Generic data sync (back-stop; specific actions below preferred)
  'data-write', 'data-delete',
  // Admin settings
  'admin-save', 'admin-discard',
  // Activity-log gate
  'activity-unlock', 'activity-unlock-failed',
  // Customer-facing
  'rate-authorize',
  // Field submissions — give us actionable rows in the log instead of
  // generic "data-write" for every kind of submission.
  'tm-submit', 'tm-edit', 'tm-delete',
  'daily-submit', 'daily-edit', 'daily-delete',
  'pretrip-submit', 'pretrip-edit',
  'equipment-submit', 'equipment-edit',
  'trucking-submit', 'trucking-edit', 'trucking-delete',
  'trucking-lock', 'trucking-unlock',
  'clockin', 'clockout',
  // Maintenance inbox
  'maint-create', 'maint-update', 'maint-close',
  // Job board / scheduler
  'job-create', 'job-update', 'job-assign', 'job-status', 'job-delete',
  // Chat
  'chat-send', 'chat-delete', 'chat-clear-channel',
  // Issues
  'issue-report'
]);

app.http('audit', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();

    const c = container();
    const method = request.method;

    try {
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const action = String(body.action || '').trim();
        if (!ALLOWED_AUDIT_ACTIONS.has(action)) return badRequest('invalid action');
        // Wrong-domain users are allowed to log ONLY the 'signin-denied'
        // event — that's the whole point: we want to know who tried.
        // Every other write requires a valid BCC domain account.
        if (!domainAllowed(p) && action !== 'signin-denied') return domainBlocked();

        const ts = new Date().toISOString();
        const id = 'audit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const doc = {
          id,
          tenantId: BCC_TENANT_ID,
          docType: 'audit',
          ts,
          action,
          user: p.userDetails || p.userId || 'unknown',
          ip: clientIp(request),
          userAgent: String(request.headers.get('user-agent') || '').slice(0, 200),
          path: body.path ? String(body.path).slice(0, 200) : null,
          key:  body.key  ? String(body.key).slice(0, 80)   : null,
          meta: body.meta != null ? body.meta : null
        };
        await c.items.create(doc);
        // Fire-and-forget push fan-out. We DO NOT await this — the audit
        // POST should respond as fast as it always did, and any push
        // error must not surface to the caller. The function host keeps
        // the request context alive long enough for our async work in
        // 99% of cases; on rare cold-stop the worst case is a missed
        // notification, never a failed submit.
        if (NOTIFY_ACTIONS.has(action)) {
          fanoutPush(action, body, p, context).catch(() => {});
        }
        return { status: 204 };
      }

      // GET — return BOTH audit (client-side semantic events) and access
      // (server-side HTTP request log) rows for this tenant, so the
      // activity log table can show the full picture in one view.
      if (!domainAllowed(p)) return domainBlocked();
      const url = new URL(request.url);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 2000));
      const since = url.searchParams.get('since');
      const docTypes = (url.searchParams.get('types') || 'audit,access')
        .split(',').map(s => s.trim()).filter(s => s === 'audit' || s === 'access');
      if (!docTypes.length) docTypes.push('audit');
      const typeList = docTypes.map(t => '"' + t + '"').join(',');
      let q;
      if (since) {
        q = {
          query: 'SELECT TOP @n c.id, c.ts, c.docType, c.action, c.user, c.ip, c.userAgent, '
               + 'c.path, c.method, c.status, c.key, c.meta '
               + 'FROM c WHERE c.tenantId = @t AND c.docType IN (' + typeList + ') AND c.ts >= @since '
               + 'ORDER BY c.ts DESC',
          parameters: [
            { name: '@n', value: limit },
            { name: '@t', value: BCC_TENANT_ID },
            { name: '@since', value: since }
          ]
        };
      } else {
        q = {
          query: 'SELECT TOP @n c.id, c.ts, c.docType, c.action, c.user, c.ip, c.userAgent, '
               + 'c.path, c.method, c.status, c.key, c.meta '
               + 'FROM c WHERE c.tenantId = @t AND c.docType IN (' + typeList + ') '
               + 'ORDER BY c.ts DESC',
          parameters: [
            { name: '@n', value: limit },
            { name: '@t', value: BCC_TENANT_ID }
          ]
        };
      }
      const { resources } = await c.items.query(q).fetchAll();
      return { jsonBody: { items: resources } };
    } catch (err) {
      context.error('audit handler error', err);
      return { status: 500, jsonBody: { error: 'server error', detail: String(err && err.message || err) } };
    }
  })
});

app.http('users', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const users = await fetchActiveUsers();
      return { jsonBody: { users, cachedAt: _usersCache && _usersCache.expiresAt - USERS_TTL_MS } };
    } catch (err) {
      context.error('users handler error', err);
      return { status: 502, jsonBody: { error: 'graph_failed', detail: String(err && err.message || err) } };
    }
  })
});

/* ============ Push notifications (additive) ============
 *
 * Architecture:
 *   - Each browser subscription is stored as a Cosmos doc with
 *     docType='push-sub' and id='push-sub-<sanitized-upn>-<hash>'.
 *     Same partition key (tenantId), same container.
 *   - The Admin "Users" tab has a per-user "Notify" checkbox stored on
 *     bcc-admin-config-v1.users[].notifyOnSubmit. Only users with that
 *     flag receive fan-out pushes.
 *   - When /api/audit POST is called with action 'tm-submit' or
 *     'trucking-lock', we look up the recipient list, load their
 *     push-sub docs, and send a push to each via web-push. All push
 *     errors are swallowed — push fan-out can NEVER break the audit
 *     POST response, which is what existing submit flows depend on.
 *   - Stale subscriptions (HTTP 404 / 410 from the push service) are
 *     deleted on the fly so we don't keep retrying dead endpoints.
 *
 * Endpoints:
 *   GET    /api/push-public-key          -> { publicKey } (anonymous-ok, harmless)
 *   POST   /api/push-subscribe           -> body: { subscription }
 *   DELETE /api/push-subscribe           -> deletes the caller's subscriptions
 */

function sanitizeUpn(upn) {
  return String(upn || 'anon').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 60);
}

function shortHash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

app.http('push-public-key', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'push-public-key',
  handler: withAccessLog(async () => {
    const pub = process.env.VAPID_PUBLIC_KEY || '';
    return { jsonBody: { publicKey: pub } };
  })
});

app.http('push-subscribe', {
  methods: ['POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'push-subscribe',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const c = container();
    const who = (p.userDetails || p.userId || 'unknown').toLowerCase();
    const userKey = sanitizeUpn(who);

    try {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const sub = body && body.subscription;
        if (!sub || !sub.endpoint) return badRequest('expected { subscription: { endpoint, keys } }');
        const id = 'push-sub-' + userKey + '-' + shortHash(sub.endpoint);
        const doc = {
          id,
          tenantId: BCC_TENANT_ID,
          docType: 'push-sub',
          user: who,
          subscription: sub,
          userAgent: String(request.headers.get('user-agent') || '').slice(0, 200),
          createdAt: new Date().toISOString()
        };
        await c.items.upsert(doc);
        return { status: 204 };
      }

      // DELETE — remove all push-sub docs owned by the caller. (Cheap;
      // a user usually has 1-3 device subscriptions at most.)
      const q = {
        query: 'SELECT c.id FROM c WHERE c.tenantId = @t AND c.docType = "push-sub" AND LOWER(c.user) = @u',
        parameters: [
          { name: '@t', value: BCC_TENANT_ID },
          { name: '@u', value: who }
        ]
      };
      const { resources } = await c.items.query(q).fetchAll();
      for (const r of resources) {
        try { await c.item(r.id, BCC_TENANT_ID).delete(); } catch (e) { if (e.code !== 404) throw e; }
      }
      return { status: 204 };
    } catch (err) {
      context.error('push-subscribe handler error', err);
      return { status: 500, jsonBody: { error: 'server error', detail: String(err && err.message || err) } };
    }
  })
});

/* ============ Fan-out helpers (called from /api/audit POST) ============ */

const NOTIFY_ACTIONS = new Set(['tm-submit', 'trucking-lock']);

async function loadNotifyRecipients() {
  const cfg = await getAdminCfg();
  if (!cfg || !Array.isArray(cfg.users)) return [];
  return cfg.users
    .filter(u => u && u.notifyOnSubmit === true && u.status !== 'inactive')
    .map(u => String((u.upn || u.email || '')).toLowerCase())
    .filter(Boolean);
}

async function loadPushSubsForUsers(users) {
  if (!users.length) return [];
  const c = container();
  // Cosmos IN() requires parameter-per-value because LOWER(IN(@p)) isn't supported.
  const placeholders = users.map((_, i) => '@u' + i).join(',');
  const params = users.map((u, i) => ({ name: '@u' + i, value: u }));
  const q = {
    query: 'SELECT c.id, c.user, c.subscription FROM c WHERE c.tenantId = @t AND c.docType = "push-sub" '
         + 'AND LOWER(c.user) IN (' + placeholders + ')',
    parameters: [{ name: '@t', value: BCC_TENANT_ID }, ...params]
  };
  const { resources } = await c.items.query(q).fetchAll();
  return resources;
}

function buildPushPayload(action, body, p) {
  const who = (p && (p.userDetails || p.userId)) || 'someone';
  const sender = who.split('@')[0];
  const meta = (body && body.meta) || {};
  const key = body && body.key ? String(body.key) : '';
  if (action === 'tm-submit') {
    const customer = meta.customer || meta.company || '';
    const total = meta.total != null ? ' · $' + Number(meta.total).toLocaleString() : '';
    const title = 'New T&M sheet — ' + sender;
    const bodyText = (customer ? customer + total : ('Submitted' + total)).slice(0, 140);
    return {
      title,
      body: bodyText,
      url: '/tm.html' + (key ? ('?id=' + encodeURIComponent(key)) : ''),
      tag: 'tm-' + (key || Date.now())
    };
  }
  if (action === 'trucking-lock') {
    const customer = meta.customer || meta.company || '';
    const loads = meta.loads != null ? ' · ' + meta.loads + ' loads' : '';
    const title = 'Trucking slip submitted — ' + sender;
    const bodyText = (customer ? customer + loads : ('Submitted' + loads)).slice(0, 140);
    return {
      title,
      body: bodyText,
      url: '/trucking.html' + (key ? ('?id=' + encodeURIComponent(key)) : ''),
      tag: 'trk-' + (key || Date.now())
    };
  }
  return null;
}

async function fanoutPush(action, body, p, context) {
  try {
    if (!NOTIFY_ACTIONS.has(action)) return;
    const wp = getWebPush();
    if (!wp) return; // VAPID not configured — silently skip

    const recipients = await loadNotifyRecipients();
    if (!recipients.length) return;

    // Don't notify the sender about their own submission.
    const sender = (p && (p.userDetails || p.userId) || '').toLowerCase();
    const targets = recipients.filter(u => u !== sender);
    if (!targets.length) return;

    const subs = await loadPushSubsForUsers(targets);
    if (!subs.length) return;

    const payload = buildPushPayload(action, body, p);
    if (!payload) return;
    const payloadStr = JSON.stringify(payload);
    const c = container();

    await Promise.allSettled(subs.map(async (row) => {
      try {
        await wp.sendNotification(row.subscription, payloadStr, { TTL: 60 * 60 * 24 });
      } catch (e) {
        // 404 / 410 -> subscription is dead, remove it
        const code = (e && (e.statusCode || e.status)) || 0;
        if (code === 404 || code === 410) {
          try { await c.item(row.id, BCC_TENANT_ID).delete(); } catch (_) {}
        } else if (context && context.warn) {
          context.warn('push send failed', code, e && e.body);
        }
      }
    }));
  } catch (e) {
    // Never throw — push fan-out is best-effort.
    if (context && context.warn) context.warn('fanoutPush error', e && e.message);
  }
}

/* ============ Integrations — credential resolver + test endpoint ============
 *
 * Admin → Integrations writes bcc-integration-<channel> docs into Cosmos
 * with shape { channel, status, fields:{...}, updatedAt }. Backend code
 * should call getIntegrationFields(channel) instead of reading process.env
 * directly, so admin-saved credentials win over Bicep-time env defaults.
 *
 * Cached 60 s per Function instance — admin changes propagate within a
 * minute; rapid integration calls don't hammer Cosmos.
 */

const _intCache = { until: 0, byChannel: new Map() };

async function getIntegrationFields(channel) {
  if (Date.now() < _intCache.until && _intCache.byChannel.has(channel)) {
    return _intCache.byChannel.get(channel);
  }
  try {
    const c = container();
    const id = 'bcc-integration-' + channel;
    const { resource } = await c.item(id, BCC_TENANT_ID).read().catch(e => { if (e.code === 404) return { resource: null }; throw e; });
    const fields = (resource && resource.fields) || {};
    _intCache.byChannel.set(channel, fields);
    _intCache.until = Date.now() + 60 * 1000;
    return fields;
  } catch (err) {
    return {};
  }
}

/**
 * POST /api/integrations/{channel}/test
 *
 * Lightweight reachability + auth check per connector. We don't pull data
 * here — just confirm the credentials parse + the provider accepts them.
 * Each branch is best-effort and tolerates "API not wired" by returning a
 * structured failure the UI can show.
 */
app.http('integrations-test', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/{channel}/test',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const channel = String(request.params.channel || '').toLowerCase();

    try {
      const fields = await getIntegrationFields(channel);

      // Channel-specific probes. Each just verifies the credentials are
      // present and the provider's auth endpoint accepts them — no data pull.
      let result;
      switch (channel) {
        case 'qbo':
          if (!fields.clientId || !fields.clientSecret) {
            result = { ok: false, error: 'clientId and clientSecret required' };
          } else {
            // Hitting Intuit's openid discovery is a cheap reachability test.
            const base = (fields.environment === 'production')
              ? 'https://accounts.intuit.com/.well-known/openid_configuration'
              : 'https://accounts.intuit.com/.well-known/openid_configuration';
            const r = await fetch(base).catch(e => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'reachability check failed' };
          }
          break;

        case 'google-ads':
          if (!fields.developerToken || !fields.clientId || !fields.clientSecret || !fields.refreshToken) {
            result = { ok: false, error: 'developerToken, clientId, clientSecret, refreshToken required' };
          } else {
            // Exchange the refresh token for a short-lived access token. If Google accepts it, creds are valid.
            const body = new URLSearchParams({
              client_id: fields.clientId,
              client_secret: fields.clientSecret,
              refresh_token: fields.refreshToken,
              grant_type: 'refresh_token'
            }).toString();
            const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }).catch(() => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'token exchange failed' };
          }
          break;

        case 'meta':
          if (!fields.accessToken) result = { ok: false, error: 'accessToken required' };
          else {
            const r = await fetch('https://graph.facebook.com/v19.0/me?access_token=' + encodeURIComponent(fields.accessToken)).catch(() => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'access token rejected' };
          }
          break;

        case 'linkedin':
          if (!fields.accessToken) result = { ok: false, error: 'accessToken required' };
          else {
            const r = await fetch('https://api.linkedin.com/v2/me', { headers: { Authorization: 'Bearer ' + fields.accessToken } }).catch(() => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'access token rejected (' + (r && r.status) + ')' };
          }
          break;

        case 'mailchimp':
          if (!fields.apiKey || !fields.serverPrefix) result = { ok: false, error: 'apiKey and serverPrefix required' };
          else {
            const r = await fetch('https://' + fields.serverPrefix + '.api.mailchimp.com/3.0/ping', {
              headers: { Authorization: 'Basic ' + Buffer.from('anystring:' + fields.apiKey).toString('base64') }
            }).catch(() => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'auth failed (' + (r && r.status) + ')' };
          }
          break;

        case 'godaddy':
          if (!fields.apiKey || !fields.apiSecret) result = { ok: false, error: 'apiKey and apiSecret required' };
          else {
            const r = await fetch('https://api.godaddy.com/v1/domains?limit=1', {
              headers: { Authorization: 'sso-key ' + fields.apiKey + ':' + fields.apiSecret }
            }).catch(() => null);
            result = r && (r.ok || r.status === 422) ? { ok: true } : { ok: false, error: 'auth failed (' + (r && r.status) + ')' };
          }
          break;

        case 'wordpress':
          if (!fields.siteUrl || !fields.username || !fields.appPassword) result = { ok: false, error: 'siteUrl, username, appPassword required' };
          else {
            const url = fields.siteUrl.replace(/\/$/, '') + '/wp-json/wp/v2/users/me';
            const r = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(fields.username + ':' + fields.appPassword).toString('base64') } }).catch(() => null);
            result = r && r.ok ? { ok: true } : { ok: false, error: 'auth failed (' + (r && r.status) + ')' };
          }
          break;

        case 'slack':
        case 'teams':
          if (!fields.webhookUrl) result = { ok: false, error: 'webhookUrl required' };
          else {
            // A HEAD/GET on the webhook 405s but proves the URL resolves. POSTing a "test" message would be intrusive.
            try {
              const u = new URL(fields.webhookUrl);
              result = (u.protocol === 'https:') ? { ok: true } : { ok: false, error: 'webhook must be https' };
            } catch (e) { result = { ok: false, error: 'invalid URL' }; }
          }
          break;

        case 'azure-blob':
          // Already wired via /api/documents; just confirm there's a connection string + container.
          if (!fields.connectionString && !process.env.AZURE_STORAGE_CONNECTION_STRING) {
            result = { ok: false, error: 'connectionString required' };
          } else {
            try { getBlobContainer(); result = { ok: true }; }
            catch (e) { result = { ok: false, error: String(e.message || e) }; }
          }
          break;

        case 'app-insights':
          if (!fields.connectionString && !process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
            result = { ok: false, error: 'connectionString required' };
          } else { result = { ok: true }; }
          break;

        case 'web-push':
          if (!fields.publicKey || !fields.privateKey) result = { ok: false, error: 'publicKey and privateKey required' };
          else result = { ok: true };
          break;

        default:
          result = { ok: false, error: 'unknown channel "' + channel + '"' };
      }

      // Mirror status into the integration doc so the UI badge sticks.
      try {
        const c = container();
        const id = 'bcc-integration-' + channel;
        const { resource } = await c.item(id, BCC_TENANT_ID).read().catch(() => ({ resource: null }));
        if (resource) {
          resource.status = result.ok ? 'connected' : 'error';
          resource.lastTest = { ...result, at: new Date().toISOString() };
          resource.updatedAt = new Date().toISOString();
          await c.items.upsert(resource);
          _intCache.until = 0; // bust cache
        }
      } catch (_) { /* best-effort */ }

      return { jsonBody: result };
    } catch (err) {
      context.error('integrations-test error', err);
      return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } };
    }
  })
});

/* ============ Azure Blob — document storage ============
 * Files don't fit in Cosmos (10 MB doc cap; not what it's designed for).
 * Per the data-shapes.md sketch: file goes to Blob, metadata stays in
 * Cosmos as bcc-document-* docs.
 *
 * AZURE_STORAGE_CONNECTION_STRING + AZURE_STORAGE_CONTAINER_DOCS must be
 * set on the SWA's app settings (done by the Bicep deploy).
 */

let _blobContainer = null;
let _blobAccount = null;

function getBlobContainer() {
  if (_blobContainer) return _blobContainer;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING not set');
  const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
  const containerName = process.env.AZURE_STORAGE_CONTAINER_DOCS || 'bcc-docs';
  const svc = BlobServiceClient.fromConnectionString(conn);
  _blobContainer = svc.getContainerClient(containerName);

  // Also parse account + key for SAS URL generation.
  const parts = {};
  conn.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1);
  });
  if (parts.AccountName && parts.AccountKey) {
    _blobAccount = new StorageSharedKeyCredential(parts.AccountName, parts.AccountKey);
  }
  return _blobContainer;
}

function safeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
function safeFolder(folder) {
  let f = String(folder || '/').trim();
  if (!f.startsWith('/')) f = '/' + f;
  f = f.replace(/[^a-zA-Z0-9._\/-]+/g, '_');
  return f.replace(/\/+/g, '/');
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOC_DOC_PREFIX = 'bcc-document-';

/**
 * POST /api/documents
 *   multipart/form-data: file (required), folder, tags, docId
 *
 * Stores the file in Blob at <tenantId>/<folder>/<timestamp>-<safefilename>,
 * then upserts a bcc-document-<docId> metadata doc in Cosmos.
 *
 * GET /api/documents
 *   List all metadata docs for the tenant.
 *
 * GET /api/documents/{id}
 *   Single doc metadata.
 *
 * GET /api/documents/{id}/download
 *   302 redirect to a short-lived (15 min) SAS URL.
 *
 * DELETE /api/documents/{id}
 *   Delete from Blob + Cosmos.
 */
app.http('documents-list-create', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'documents',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();

    if (request.method === 'GET') {
      // List metadata docs (same shape as /api/data filtered to docType=document).
      try {
        const c = container();
        const q = {
          query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.docType = "document" ORDER BY c.createdAt DESC',
          parameters: [{ name: '@t', value: BCC_TENANT_ID }]
        };
        const { resources } = await c.items.query(q).fetchAll();
        return { jsonBody: { items: resources } };
      } catch (err) {
        context.error('documents list error', err);
        return { status: 500, jsonBody: { error: 'list failed', detail: String(err && err.message || err) } };
      }
    }

    // POST — multipart upload.
    try {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return badRequest('expected "file" form field');
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > MAX_UPLOAD_BYTES) return badRequest('file exceeds 25 MB');

      const folder = safeFolder(form.get('folder') || '/');
      const tags = String(form.get('tags') || '').trim();
      const docId = String(form.get('docId') || (DOC_DOC_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 9)));

      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const filename = safeFilename(file.name || 'file');
      const storageKey = (BCC_TENANT_ID + folder + '/' + stamp + '-' + filename).replace(/\/+/g, '/').replace(/^\//, '');

      // Upload to Blob
      const cont = getBlobContainer();
      try { await cont.createIfNotExists(); } catch (_) {}
      const blob = cont.getBlockBlobClient(storageKey);
      await blob.uploadData(buf, {
        blobHTTPHeaders: { blobContentType: file.type || 'application/octet-stream' }
      });

      // Upsert metadata doc in Cosmos
      const who = (p.userDetails || p.userId || '').toLowerCase();
      const now = new Date().toISOString();
      const c = container();
      const meta = {
        id: docId,
        tenantId: BCC_TENANT_ID,
        docType: 'document',
        name: file.name,
        folder: folder,
        tags: tags,
        sizeBytes: buf.length,
        mimeType: file.type || 'application/octet-stream',
        storageKey: storageKey,
        uploaderUpn: who,
        createdAt: now,
        updatedAt: now
      };
      await c.items.upsert(meta);

      return { jsonBody: { ok: true, id: meta.id, storageKey: storageKey, sizeBytes: meta.sizeBytes } };
    } catch (err) {
      context.error('documents upload error', err);
      return { status: 500, jsonBody: { error: 'upload failed', detail: String(err && err.message || err) } };
    }
  })
});

app.http('document-one', {
  methods: ['GET', 'DELETE'],
  authLevel: 'anonymous',
  route: 'documents/{id}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const id = request.params.id;
    if (!id || id.indexOf(DOC_DOC_PREFIX) !== 0) return badRequest('bad id');

    const c = container();
    try {
      if (request.method === 'GET') {
        const { resource } = await c.item(id, BCC_TENANT_ID).read();
        if (!resource) return { status: 404, jsonBody: { error: 'not found' } };
        return { jsonBody: resource };
      }

      // DELETE — remove from Blob + Cosmos
      let meta = null;
      try { ({ resource: meta } = await c.item(id, BCC_TENANT_ID).read()); } catch (e) { if (e.code !== 404) throw e; }
      if (meta && meta.storageKey) {
        try {
          const cont = getBlobContainer();
          await cont.getBlockBlobClient(meta.storageKey).deleteIfExists();
        } catch (be) { context.warn && context.warn('blob delete failed', be && be.message); }
      }
      try { await c.item(id, BCC_TENANT_ID).delete(); } catch (e) { if (e.code !== 404) throw e; }
      return { status: 204 };
    } catch (err) {
      context.error('document one error', err);
      return { status: 500, jsonBody: { error: 'server error', detail: String(err && err.message || err) } };
    }
  })
});

app.http('document-download', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'documents/{id}/download',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const id = request.params.id;
    if (!id || id.indexOf(DOC_DOC_PREFIX) !== 0) return badRequest('bad id');

    try {
      const c = container();
      const { resource: meta } = await c.item(id, BCC_TENANT_ID).read();
      if (!meta || !meta.storageKey) return { status: 404, jsonBody: { error: 'no file' } };
      const cont = getBlobContainer();
      if (!_blobAccount) return { status: 500, jsonBody: { error: 'blob credentials not parseable for SAS generation' } };

      const { BlobSASPermissions, generateBlobSASQueryParameters } = require('@azure/storage-blob');
      const now = new Date();
      const expiry = new Date(now.getTime() + 15 * 60 * 1000); // 15 minute window
      const filename = String(meta.name || 'file').replace(/[\r\n"]/g, '');
      const sas = generateBlobSASQueryParameters({
        containerName: cont.containerName,
        blobName: meta.storageKey,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(now.getTime() - 60 * 1000),
        expiresOn: expiry,
        contentDisposition: 'attachment; filename="' + filename + '"',
        contentType: meta.mimeType || 'application/octet-stream'
      }, _blobAccount).toString();
      const url = cont.getBlockBlobClient(meta.storageKey).url + '?' + sas;
      return { status: 302, headers: { Location: url } };
    } catch (err) {
      context.error('document-download error', err);
      return { status: 500, jsonBody: { error: 'download failed', detail: String(err && err.message || err) } };
    }
  })
});

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

// Email-domain allowlist used by /api/users when filtering the Graph tenant
// directory down to BCC employees (drops guests / external members so they
// never reach an internal dropdown). Override with env BCC_ALLOWED_DOMAINS
// (comma-separated, no leading @).
const ALLOWED_DOMAINS = (process.env.BCC_ALLOWED_DOMAINS || 'bluecollarcoach.us,bluecollarcoach.onmicrosoft.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

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

/* SWA "Managed Functions" run on a separate *.azurewebsites.net host. If we
 * derive OAuth redirect URIs from request.url.origin, we get the INTERNAL
 * function host — which isn't what we registered with Entra / Intuit / etc.
 * The public host is preserved in x-forwarded-host (set by SWA's edge).
 * Falls back to the request URL only when no forwarded host is present (dev).
 */
function publicOrigin(req) {
  // SWA forwards the public URL in x-ms-original-url. Check that FIRST
  // because the new SWA instance doesn't always populate x-forwarded-host.
  const original = req.headers.get('x-ms-original-url');
  if (original) {
    try { return new URL(original).origin; } catch (_) { /* fall through */ }
  }
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host  = req.headers.get('x-forwarded-host')
             || req.headers.get('x-original-host')
             || req.headers.get('host');
  if (host) return proto + '://' + host;
  return new URL(req.url).origin;
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
        let touchesIntegration = false;
        for (const it of items) {
          if (!isPcKey(it.key)) return badRequest('invalid key: ' + it.key);
          if (ADMIN_KEYS.has(it.key)) touchesAdminKey = true;
          if (it.key.startsWith('bcc-integration-')) touchesIntegration = true;
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
        // Same idea for integration credential writes — the OAuth /connect
        // endpoints read getIntegrationFields() immediately on the next
        // request, and we don't want that to return cached empty fields
        // after a UI Save → Connect flow.
        if (touchesIntegration) { _intCache.until = 0; _intCache.byChannel.clear(); }
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
  // Admin settings + integration credentials
  'admin-config-save', 'admin-discard', 'admin-export',
  'customer-types-save',
  'integration-save', 'integration-clear',
  // Auth / activity-log gate
  'signin-denied', 'activity-unlock', 'activity-unlock-failed',
  // CRM
  'contact-create', 'contact-update', 'contact-delete',
  'convo-add', 'convo-delete', 'need-add',
  'company-create', 'company-update', 'company-delete',
  'deal-create', 'deal-update', 'deal-delete',
  // Sessions
  'session-create', 'session-update', 'session-delete',
  // Engagements / pipeline
  'engagement-create', 'engagement-update', 'engagement-stage', 'engagement-delete',
  // Documents
  'document-metadata-add', 'document-upload', 'document-delete', 'document-download',
  // Rates / signatures
  'rate-sheet-save', 'rate-signature',
  // My Day / time
  'clock-in', 'clock-out', 'daily-log-save',
  // Chat
  'chat-send', 'chat-delete', 'chat-clear-channel',
  // Marketing / campaigns
  'campaign-create', 'campaign-update', 'campaign-delete',
  // Training / events / KB
  'course-create', 'course-update', 'enrollment-update',
  'event-create', 'event-update', 'event-delete',
  'kb-article-create', 'kb-article-update', 'kb-article-delete',
  // Issues / inbox
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

/* ============ /api/whoami — debug for the redirect-URI + Graph permission saga
 * Returns the public origin we'd use for OAuth redirect URIs, the forwarded
 * headers, and whether the Graph token call works. Visit this in a browser
 * while signed in to see exactly what the Function sees.
 */
app.http('whoami', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    const out = {
      signedIn: !!p,
      userDetails: p ? p.userDetails : null,
      userRoles: p ? p.userRoles : null,
      publicOrigin: publicOrigin(request),
      requestUrlOrigin: new URL(request.url).origin,
      headers: {
        host: request.headers.get('host'),
        xForwardedHost:  request.headers.get('x-forwarded-host'),
        xOriginalHost:   request.headers.get('x-original-host'),
        xForwardedProto: request.headers.get('x-forwarded-proto'),
        xMsOriginalUrl:  request.headers.get('x-ms-original-url')
      },
      env: {
        AZURE_TENANT_ID:    !!process.env.AZURE_TENANT_ID,
        AZURE_CLIENT_ID:    !!process.env.AZURE_CLIENT_ID,
        AZURE_CLIENT_SECRET: !!process.env.AZURE_CLIENT_SECRET,
        ALLOWED_DOMAINS:    ALLOWED_DOMAINS
      },
      graphToken: { ok: false, error: null },
      graphUsersCall: { ok: false, count: null, error: null }
    };
    // Probe the Graph token endpoint
    try { await getGraphToken(); out.graphToken.ok = true; }
    catch (e) { out.graphToken.error = String(e.message || e); }
    // Probe the actual user list (this is what /api/users uses)
    try {
      const u = await fetchActiveUsers();
      out.graphUsersCall.ok = true;
      out.graphUsersCall.count = u.length;
    } catch (e) {
      out.graphUsersCall.error = String(e.message || e);
    }
    return { jsonBody: out };
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

// Actions that fan out via Web Push to anyone who opted in via
// admin-config.users[*].notifyOnSubmit. Extend as new "we want a
// notification when X" use cases emerge.
const NOTIFY_ACTIONS = new Set([
  'rate-signature',      // a customer signed a rate sheet
  'session-create'       // a new coaching session was booked
  // NOTE: deal/engagement changes are surfaced to ADMINS ONLY via the in-app
  // notification center (client poller in bcc-api.js), not this broad push
  // fan-out, so they are not listed here.
]);

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
  if (action === 'rate-signature') {
    const signedBy = meta.signedBy || '';
    const title = 'New signature captured';
    const bodyText = (signedBy ? signedBy + ' signed the rate sheet' : 'Customer signed the rate sheet').slice(0, 140);
    return {
      title, body: bodyText,
      url: '/rates.html' + (key ? ('?id=' + encodeURIComponent(key)) : ''),
      tag: 'rate-sig-' + (key || Date.now())
    };
  }
  if (action === 'session-create') {
    const title = 'New coaching session booked';
    const bodyText = (sender ? 'Booked by ' + sender : 'A session was booked').slice(0, 140);
    return {
      title, body: bodyText,
      url: '/sessions.html' + (key ? ('?id=' + encodeURIComponent(key)) : ''),
      tag: 'sess-' + (key || Date.now())
    };
  }
  if (action === 'engagement-stage') {
    const stage = meta.stage || '';
    const title = 'Engagement moved' + (stage ? ' → ' + stage : '');
    const bodyText = ('Updated by ' + sender).slice(0, 140);
    return {
      title, body: bodyText,
      url: '/jobs.html' + (key ? ('?id=' + encodeURIComponent(key)) : ''),
      tag: 'eng-' + (key || Date.now())
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

/* ============ Scheduled reminders (Web Push when the app is closed) ============
 *
 * POST /api/cron/reminders  — called by an external scheduler (GitHub Actions
 * cron). Auth is a shared secret in the 'x-bcc-cron-secret' header matching the
 * CRON_SECRET app setting (NOT the SWA Entra cookie — this runs headless).
 *
 * Scans every session + event doc, and for each one starting within the next
 * 24h fires two reminders exactly once each: a "day-ahead" (<=24h, >15m) and a
 * "starting soon" (<=15m). De-dupe markers live in a single Cosmos doc
 * (bcc-reminder-sent-v1). Recipients = anyone with a push subscription; a
 * session with a coachUpn is sent only to that coach. The in-app bell handles
 * the same reminders when a tab is open; this covers the closed-app case.
 */
const REM_DAY_MS = 24 * 60 * 60 * 1000;
const REM_MIN15_MS = 15 * 60 * 1000;
const REM_SENT_ID = 'bcc-reminder-sent-v1';

async function loadAllPushSubs() {
  const c = container();
  const q = {
    query: 'SELECT c.id, c.user, c.subscription FROM c WHERE c.tenantId = @t AND c.docType = "push-sub"',
    parameters: [{ name: '@t', value: BCC_TENANT_ID }]
  };
  const { resources } = await c.items.query(q).fetchAll();
  return resources;
}

function remFmtTime(t) {
  try {
    return new Date(t).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
    });
  } catch (e) { return new Date(t).toISOString(); }
}

app.http('cron-reminders', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'cron/reminders',
  handler: async (request, context) => {
    const secret = process.env.CRON_SECRET || '';
    const given = request.headers.get('x-bcc-cron-secret') || '';
    if (!secret || given !== secret) return { status: 401, jsonBody: { ok: false, error: 'bad or missing cron secret' } };

    const wp = getWebPush();
    if (!wp) return { status: 200, jsonBody: { ok: true, skipped: 'VAPID not configured' } };

    const c = container();
    const now = Date.now();

    try {
      // 1) Load upcoming sessions + events.
      const q = {
        query: 'SELECT c.id, c.data FROM c WHERE c.tenantId = @t AND (STARTSWITH(c.id, "bcc-session-") OR STARTSWITH(c.id, "bcc-event-"))',
        parameters: [{ name: '@t', value: BCC_TENANT_ID }]
      };
      const { resources: docs } = await c.items.query(q).fetchAll();

      // 2) De-dupe marker doc.
      let sentDoc = null;
      try {
        const r = await c.item(REM_SENT_ID, BCC_TENANT_ID).read();
        sentDoc = r.resource;
      } catch (e) { if (e.code !== 404) throw e; }
      const sent = (sentDoc && sentDoc.data && sentDoc.data.map) ? sentDoc.data.map : {};

      // 3) Subscriptions grouped by lowercased user.
      const subs = await loadAllPushSubs();
      const subsByUser = new Map();
      for (const s of subs) {
        const u = String(s.user || '').toLowerCase();
        if (!subsByUser.has(u)) subsByUser.set(u, []);
        subsByUser.get(u).push(s);
      }
      const allSubs = subs;

      const toSend = []; // { sub, payload }
      let dueCount = 0;

      for (const d of docs) {
        const data = d.data || {};
        const startAt = data.startAt;
        if (!startAt) continue;
        const t = Date.parse(startAt);
        if (isNaN(t) || t <= now) continue;
        const remaining = t - now;
        if (remaining > REM_DAY_MS) continue;

        const isSession = d.id.indexOf('bcc-session-') === 0;
        const title = data.title || (isSession ? 'Coaching session' : 'Event');
        const loc = data.location ? ' · ' + data.location : '';
        let kind, payloadTitle, payloadBody;
        if (remaining <= REM_MIN15_MS) {
          kind = '15m'; payloadTitle = 'Starting soon: ' + title; payloadBody = 'Begins ' + remFmtTime(t) + loc;
        } else {
          kind = 'day'; payloadTitle = 'Upcoming: ' + title; payloadBody = 'Starts ' + remFmtTime(t) + loc;
        }
        const marker = d.id + ':' + kind;
        if (sent[marker]) continue;
        sent[marker] = now;
        dueCount++;

        // Recipients: a session with a coachUpn → just that coach; otherwise
        // everyone who has a push subscription.
        let targetSubs;
        if (isSession && data.coachUpn) {
          targetSubs = subsByUser.get(String(data.coachUpn).toLowerCase()) || [];
        } else {
          targetSubs = allSubs;
        }
        const payload = JSON.stringify({
          title: payloadTitle,
          body: payloadBody,
          url: isSession ? '/sessions.html' : '/events.html',
          tag: marker
        });
        for (const s of targetSubs) toSend.push({ sub: s, payload });
      }

      // 4) Send + clean up dead subscriptions.
      let okCount = 0, deadCount = 0;
      await Promise.allSettled(toSend.map(async ({ sub, payload }) => {
        try {
          await wp.sendNotification(sub.subscription, payload, { TTL: 60 * 60 });
          okCount++;
        } catch (e) {
          const code = (e && (e.statusCode || e.status)) || 0;
          if (code === 404 || code === 410) {
            deadCount++;
            try { await c.item(sub.id, BCC_TENANT_ID).delete(); } catch (_) {}
          }
        }
      }));

      // 5) Persist de-dupe markers, pruning anything older than 3 days.
      for (const k of Object.keys(sent)) { if (now - sent[k] > 3 * REM_DAY_MS) delete sent[k]; }
      await c.items.upsert({ id: REM_SENT_ID, tenantId: BCC_TENANT_ID, docType: 'reminder-sent', data: { map: sent }, updatedAt: new Date().toISOString() });

      return { jsonBody: { ok: true, scanned: docs.length, due: dueCount, pushed: okCount, pruned: deadCount } };
    } catch (err) {
      context.error('cron-reminders error', err);
      return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } };
    }
  }
});

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
    // Two write paths produce two doc shapes:
    //   1) UI save via /api/data PUT  -> { id, tenantId, data: { fields, status, ... }, updatedAt, updatedBy }
    //   2) OAuth callback upserts     -> { id, tenantId, docType, channel, fields, status, ... }
    // Read both so the Connect flow doesn't return empty fields after a UI save.
    const fields = (resource && (
      resource.fields ||
      (resource.data && resource.data.fields)
    )) || {};
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
            // Intuit's OpenID discovery doc is the correct reachability probe.
            const base = (fields.environment === 'production')
              ? 'https://developer.api.intuit.com/.well-known/openid_configuration'
              : 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration';
            const r = await fetch(base).catch(() => null);
            result = r && r.ok
              ? { ok: true, note: 'Credentials present and Intuit reachable. Click "Connect QBO" to authorize a company.' }
              : { ok: false, error: 'could not reach Intuit discovery endpoint (' + (r && r.status) + ')' };
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

/**
 * POST /api/integrations/{channel}/notify
 *
 * Fire an outbound notification through a webhook-style channel (Slack or
 * Teams today). Body: { text } — the message to send. Server-side reads
 * the webhook URL from bcc-integration-<channel>.fields.webhookUrl so
 * the user's saved credentials are the source of truth.
 */
app.http('integrations-notify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/{channel}/notify',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const channel = String(request.params.channel || '').toLowerCase();
    if (channel !== 'slack' && channel !== 'teams') return badRequest('only slack and teams supported');

    try {
      const fields = await getIntegrationFields(channel);
      if (!fields.webhookUrl) return badRequest('webhookUrl not set in Admin → Integrations');
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || 'BCC Connect: test message').slice(0, 2000);

      // Slack + Teams accept slightly different payload shapes; both
      // accept the simple { text } form for incoming-webhook style endpoints.
      const payload = channel === 'teams'
        ? { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', text: text, themeColor: 'a8884a' }
        : { text: text };

      const r = await fetch(fields.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(e => null);

      if (!r || !r.ok) {
        return { jsonBody: { ok: false, error: 'webhook rejected (' + (r && r.status) + ')' } };
      }
      return { jsonBody: { ok: true } };
    } catch (err) {
      context.error('integrations-notify error', err);
      return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } };
    }
  })
});

/**
 * POST /api/integrations/qbo/sync
 *
 * Pulls last-12-months P&L from QuickBooks and upserts one
 * bcc-financial-period-<yyyy-mm> doc per month. Uses the OAuth refresh
 * token stored in bcc-integration-qbo.fields to mint a short-lived access
 * token, then calls QBO Reports API.
 *
 * Returns { periods: [{period, revenueCents, expensesCents}, ...] } so
 * the client (bookkeeping.html) can mirror the periods into localStorage.
 *
 * Until the user completes the OAuth flow (separate /api/integrations/qbo/connect
 * endpoint, deferred), this returns a structured "not connected" payload
 * the bookkeeping page already handles gracefully.
 */
app.http('integrations-qbo-sync', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/sync',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const fields = await getIntegrationFields('qbo');
      if (!fields.clientId || !fields.clientSecret) {
        return { status: 400, jsonBody: { ok: false, error: 'QBO app credentials missing (clientId/clientSecret). Set them in Admin → Integrations.' } };
      }
      const c = container();
      const body = await request.json().catch(() => ({}));

      // Which companies to sync — one (body.realmId) or every connected company.
      let companyDocs;
      if (body && body.realmId) {
        const d = await c.item('bcc-qbo-company-' + body.realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
        companyDocs = d ? [d] : [];
      } else {
        const { resources } = await c.items.query({
          query: 'SELECT * FROM c WHERE c.tenantId=@t AND c.docType="qbo-company"',
          parameters: [{ name: '@t', value: BCC_TENANT_ID }]
        }).fetchAll();
        companyDocs = resources;
      }
      if (!companyDocs.length) {
        return { status: 400, jsonBody: { ok: false, error: 'No QBO companies connected yet. Click "Connect a company" first.' } };
      }

      const basic = Buffer.from(fields.clientId + ':' + fields.clientSecret).toString('base64');
      const now = new Date();
      const out = [];

      for (const comp of companyDocs) {
        const env = comp.environment === 'production' ? 'production'
                  : (fields.environment === 'production' ? 'production' : 'sandbox');
        const base = env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';

        // refresh token → access token (per company)
        const tokR = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + basic, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: comp.refreshToken }).toString()
        });
        if (!tokR.ok) { out.push({ realmId: comp.realmId, companyName: comp.companyName, error: 'token refresh failed (' + tokR.status + ')' }); continue; }
        const tok = await tokR.json();
        const accessToken = tok.access_token;
        if (tok.refresh_token && tok.refresh_token !== comp.refreshToken) comp.refreshToken = tok.refresh_token; // rotation

        // last 12 calendar months of P&L
        const periods = [];
        const diag = { firstStatus: null, firstBody: null };
        for (let i = 0; i < 12; i++) {
          const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const startStr = target.toISOString().slice(0, 10);
          const end = new Date(target.getFullYear(), target.getMonth() + 1, 0);
          const endStr = end.toISOString().slice(0, 10);
          const url = base + '/v3/company/' + encodeURIComponent(comp.realmId) +
            '/reports/ProfitAndLoss?start_date=' + startStr + '&end_date=' + endStr + '&accounting_method=Accrual&minorversion=70';
          const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
          if (i === 0) { diag.firstStatus = r.status; if (!r.ok) diag.firstBody = (await r.text().catch(() => '')).slice(0, 400); }
          if (!r.ok) continue;
          const j = await r.json().catch(() => null);
          let income = 0, expense = 0;
          try {
            const rows = (j && j.Rows && j.Rows.Row) || [];
            for (const row of rows) {
              const group = row.group || row.type || '';
              const summary = row.Summary && row.Summary.ColData && row.Summary.ColData[1] ? parseFloat(row.Summary.ColData[1].value || '0') : 0;
              if (/income/i.test(group)) income += summary;
              else if (/expense/i.test(group) || /cogs/i.test(group)) expense += summary;
            }
          } catch (_) {}
          const periodKey = startStr.slice(0, 7);
          periods.push({
            id: 'bcc-financial-period-' + comp.realmId + '-' + periodKey,
            tenantId: BCC_TENANT_ID, docType: 'financial-period',
            realmId: comp.realmId, companyName: comp.companyName,
            period: periodKey,
            revenueCents: Math.round(income * 100),
            expensesCents: Math.round(expense * 100),
            netCents: Math.round((income - expense) * 100),
            source: 'qbo', syncedAt: new Date().toISOString()
          });
        }
        for (const per of periods) { try { await c.items.upsert(per); } catch (_) {} }
        comp.lastSyncAt = new Date().toISOString();
        comp.updatedAt = comp.lastSyncAt;
        try { await c.items.upsert(comp); } catch (_) {}
        try { await c.items.upsert({ id: 'bcc-qbo-debug-sync', tenantId: BCC_TENANT_ID, docType: 'qbo-debug', at: new Date().toISOString(), realmId: comp.realmId, env, base, periodsBuilt: periods.length, firstStatus: diag.firstStatus, firstBody: diag.firstBody }); } catch (_) {}
        out.push({ realmId: comp.realmId, companyName: comp.companyName, periodsBuilt: periods.length, firstStatus: diag.firstStatus, firstBody: diag.firstBody, periods });
      }

      return { jsonBody: { ok: true, companies: out } };
    } catch (err) {
      context.error('qbo-sync error', err);
      return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } };
    }
  })
});

/* ============ Microsoft Graph — calendar sync ============
 *
 * Per-user OAuth (delegated). Each user clicks "Connect Outlook" once;
 * we capture their refresh token and store it on the user's record in
 * bcc-admin-config-v1.users[<them>].msGraphRefreshToken. Subsequent
 * session create/update/delete fires a Graph mirror that creates a
 * matching event in their Outlook calendar.
 *
 * Endpoints:
 *   GET  /api/integrations/msgraph/connect          start OAuth (302 to Microsoft)
 *   GET  /api/integrations/msgraph/callback         OAuth return (302 back to /admin.html)
 *   POST /api/integrations/msgraph/upsert-event     create/update event on Outlook
 *   POST /api/integrations/msgraph/delete-event     delete event on Outlook
 *
 * Scopes requested (matches the Entra app's delegated permissions):
 *   openid profile email offline_access User.Read Calendars.ReadWrite Mail.Send
 */

const GRAPH_SCOPES = 'openid profile email offline_access User.Read Calendars.ReadWrite Mail.Send';

function msGraphTenantAuthUrl(tenantId) {
  // Default to /common so personal + work accounts both resolve; the
  // openIdIssuer in staticwebapp.config.json pins the SWA sign-in to
  // the tenant, but the Graph OAuth can be /common safely.
  return 'https://login.microsoftonline.com/' + (tenantId || 'common');
}

async function loadMsGraphTokensFor(upn) {
  const cfg = await getAdminCfg();
  if (!cfg || !Array.isArray(cfg.users)) return null;
  const lc = String(upn || '').toLowerCase();
  const u = cfg.users.find(x => (x.upn || '').toLowerCase() === lc);
  if (!u || !u.msGraphRefreshToken) return null;
  return { refreshToken: u.msGraphRefreshToken };
}

async function saveMsGraphTokensFor(upn, refreshToken, displayName) {
  const c = container();
  const id = 'bcc-admin-config-v1';
  let cfg = await c.item(id, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  if (!cfg) cfg = { id, tenantId: BCC_TENANT_ID, docType: 'admin-config', users: [], updatedAt: new Date().toISOString() };
  if (!Array.isArray(cfg.users)) cfg.users = [];
  const lc = String(upn || '').toLowerCase();
  let u = cfg.users.find(x => (x.upn || '').toLowerCase() === lc);
  if (!u) {
    u = { upn, displayName: displayName || upn, role: 'member', status: 'active' };
    cfg.users.push(u);
  }
  u.msGraphRefreshToken = refreshToken;
  u.msGraphConnectedAt = new Date().toISOString();
  cfg.updatedAt = new Date().toISOString();
  await c.items.upsert(cfg);
  invalidateAdminCfgCache();
}

async function exchangeGraphCode(code, redirectUri) {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!clientId || !clientSecret) throw new Error('AZURE_CLIENT_ID / AZURE_CLIENT_SECRET not set');
  const url = msGraphTenantAuthUrl(tenantId) + '/oauth2/v2.0/token';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
    scope: GRAPH_SCOPES
  }).toString();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('code-exchange failed (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function refreshGraphAccessToken(refreshToken) {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  const url = msGraphTenantAuthUrl(tenantId) + '/oauth2/v2.0/token';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: GRAPH_SCOPES
  }).toString();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('refresh failed (' + r.status + ')');
  return r.json();
}

app.http('msgraph-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const clientId = process.env.AZURE_CLIENT_ID;
    const tenantId = process.env.AZURE_TENANT_ID;
    const origin = publicOrigin(request);
    const redirectUri = origin + '/api/integrations/msgraph/callback';
    // state = base64-encoded upn so the callback knows who to attach the token to
    const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, t: Date.now() })).toString('base64url');
    const authUrl = msGraphTenantAuthUrl(tenantId) + '/oauth2/v2.0/authorize?' + new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: GRAPH_SCOPES,
      state: state,
      prompt: 'select_account'
    }).toString();
    return { status: 302, headers: { Location: authUrl } };
  })
});

app.http('msgraph-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    if (err) return { status: 302, headers: { Location: '/admin.html?msgraph=' + encodeURIComponent(err) } };
    if (!code || !state) return { status: 400, jsonBody: { error: 'missing code or state' } };
    try {
      let stateObj = {};
      try { stateObj = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')); } catch (_) {}
      const upn = stateObj.upn || (principal(request) && principal(request).userDetails) || '';
      const redirectUri = publicOrigin(request) + '/api/integrations/msgraph/callback';
      const tok = await exchangeGraphCode(code, redirectUri);
      if (!tok.refresh_token) throw new Error('Microsoft did not return a refresh_token (did the app reg request offline_access?)');
      await saveMsGraphTokensFor(upn, tok.refresh_token, '');
      return { status: 302, headers: { Location: '/admin.html?msgraph=connected#integrations' } };
    } catch (e) {
      context.error('msgraph callback failed', e);
      return { status: 302, headers: { Location: '/admin.html?msgraph=error&detail=' + encodeURIComponent(e.message) } };
    }
  })
});

/**
 * POST /api/integrations/msgraph/upsert-event
 *   body: { graphEventId?, subject, start, end, location, body, sessionId }
 *   Creates a new event in the caller's Outlook calendar if graphEventId
 *   is empty, otherwise PATCHes the existing one. Returns { ok, graphEventId }.
 */
app.http('msgraph-upsert-event', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/upsert-event',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const body = await request.json().catch(() => ({}));
      // App-only Graph: works automatically for every signed-in user — no per-user "Connect".
      const upn = encodeURIComponent(p.userDetails || p.userId);
      const access = await getGraphToken();

      const eventPayload = {
        subject: body.subject || '(untitled session)',
        body: { contentType: 'text', content: body.body || '' },
        start: { dateTime: body.start, timeZone: 'UTC' },
        end:   { dateTime: body.end   || body.start, timeZone: 'UTC' },
        location: body.location ? { displayName: body.location } : undefined,
        // tag the event so we can de-dupe / find it again
        singleValueExtendedProperties: body.sessionId ? [
          { id: 'String {00020329-0000-0000-C000-000000000046} Name BCC_SessionId', value: String(body.sessionId) }
        ] : undefined
      };
      const graphBase = 'https://graph.microsoft.com/v1.0/users/' + upn + '/events';
      let r;
      if (body.graphEventId) {
        r = await fetch(graphBase + '/' + encodeURIComponent(body.graphEventId), {
          method: 'PATCH', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
          body: JSON.stringify(eventPayload)
        });
      } else {
        r = await fetch(graphBase, {
          method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
          body: JSON.stringify(eventPayload)
        });
      }
      if (!r.ok) return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')', detail: (await r.text()).slice(0, 200) } };
      const ev = await r.json();
      return { jsonBody: { ok: true, graphEventId: ev.id } };
    } catch (e) {
      context.error('msgraph upsert-event error', e);
      return { status: 500, jsonBody: { ok: false, error: String(e.message || e) } };
    }
  })
});

app.http('msgraph-delete-event', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/delete-event',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const body = await request.json().catch(() => ({}));
      if (!body.graphEventId) return badRequest('graphEventId required');
      const upn = encodeURIComponent(p.userDetails || p.userId);
      const access = await getGraphToken();
      const r = await fetch('https://graph.microsoft.com/v1.0/users/' + upn + '/events/' + encodeURIComponent(body.graphEventId), {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + access }
      });
      if (!r.ok && r.status !== 404) return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')' } };
      return { jsonBody: { ok: true } };
    } catch (e) {
      context.error('msgraph delete-event error', e);
      return { status: 500, jsonBody: { ok: false, error: String(e.message || e) } };
    }
  })
});

/**
 * POST /api/integrations/msgraph/send-mail
 *   body: { to: [emails], subject, bodyHtml, ccUpn?, audit?: { action, key, meta } }
 *
 * Sends an email FROM the caller's mailbox via /me/sendMail. Requires
 * the user has connected Outlook (Mail.Send scope already requested by
 * msgraph/connect). Used by Rate Sheet → "Send for review" and any other
 * outbound mail from BCC Connect.
 */
app.http('msgraph-send-mail', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/send-mail',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const body = await request.json().catch(() => ({}));
      const toList = Array.isArray(body.to) ? body.to : (body.to ? [body.to] : []);
      if (!toList.length) return badRequest('to[] required');
      const subject = String(body.subject || '(no subject)').slice(0, 250);
      const html = String(body.bodyHtml || body.body || '');

      const upn = encodeURIComponent(p.userDetails || p.userId);
      const access = await getGraphToken();

      const ccList  = Array.isArray(body.cc)  ? body.cc  : (body.cc  ? [body.cc]  : []);
      const bccList = Array.isArray(body.bcc) ? body.bcc : (body.bcc ? [body.bcc] : []);
      const recip = e => ({ emailAddress: { address: String(e) } });
      const msg = {
        subject: subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: toList.filter(Boolean).map(recip)
      };
      if (ccList.length)  msg.ccRecipients  = ccList.filter(Boolean).map(recip);
      if (bccList.length) msg.bccRecipients = bccList.filter(Boolean).map(recip);
      const payload = { message: msg, saveToSentItems: true };
      const r = await fetch('https://graph.microsoft.com/v1.0/users/' + upn + '/sendMail', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok && r.status !== 202) {
        const detail = (await r.text()).slice(0, 300);
        return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')', detail } };
      }
      return { jsonBody: { ok: true } };
    } catch (e) {
      context.error('msgraph send-mail error', e);
      return { status: 500, jsonBody: { ok: false, error: String(e.message || e) } };
    }
  })
});

/**
 * POST /api/integrations/msgraph/pull-events
 *   body: { rangeStart?: ISO, rangeEnd?: ISO }
 *   Defaults to "today through next 28 days" if no range supplied.
 *
 * Pulls calendar events from the caller's Outlook in that window and
 * returns them as bcc-session-shaped objects. The client (sessions.html)
 * decides whether to mirror them into localStorage — we de-dupe by
 * graphEventId so re-pulling is idempotent.
 *
 * Read-only against Graph; never writes back. The push half lives in
 * /upsert-event above.
 */
app.http('msgraph-pull-events', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/pull-events',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const body = await request.json().catch(() => ({}));
      const upn = encodeURIComponent(p.userDetails || p.userId);
      const access = await getGraphToken();

      const now = new Date();
      const rangeStart = body.rangeStart || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const rangeEnd   = body.rangeEnd   || new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString();

      // calendarView returns expanded recurring instances, which is what we want.
      const url = 'https://graph.microsoft.com/v1.0/users/' + upn + '/calendarView?' + new URLSearchParams({
        startDateTime: rangeStart,
        endDateTime: rangeEnd,
        $select: 'id,subject,start,end,location,bodyPreview,isAllDay,showAs,categories',
        $top: '250',
        $orderby: 'start/dateTime'
      }).toString();
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access, Prefer: 'outlook.timezone="UTC"' } });
      if (!r.ok) return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')' } };
      const data = await r.json();
      const events = Array.isArray(data.value) ? data.value : [];

      // Shape into bcc-session candidates. The client will:
      //  - skip those whose msGraphId is already present (idempotent merge)
      //  - skip those whose start is in the past beyond the user's lookback
      //  - create new bcc-session-* docs for the rest.
      const out = events.map(function (e) {
        return {
          msGraphId: e.id,
          title: e.subject || '(untitled event)',
          startAt: e.start && e.start.dateTime ? new Date(e.start.dateTime + 'Z').toISOString() : null,
          endAt:   e.end   && e.end.dateTime   ? new Date(e.end.dateTime + 'Z').toISOString() : null,
          location: (e.location && e.location.displayName) || '',
          prepNotes: e.bodyPreview || '',
          allDay: !!e.isAllDay,
          showAs: e.showAs,
          categories: e.categories || [],
          source: 'msgraph'
        };
      }).filter(function (s) { return s.startAt; });

      return { jsonBody: { ok: true, events: out, range: { start: rangeStart, end: rangeEnd } } };
    } catch (e) {
      context.error('msgraph pull-events error', e);
      return { status: 500, jsonBody: { ok: false, error: String(e.message || e) } };
    }
  })
});

/* ============ QuickBooks Online — OAuth + auto-capture ============
 *
 * Intuit OAuth 2.0. User clicks Connect QBO in Admin → Integrations →
 * we redirect to appcenter.intuit.com → on return we capture the
 * realmId (company id) + refresh token directly into
 * bcc-integration-qbo.fields, so the existing /api/integrations/qbo/sync
 * endpoint can pull P&L without anyone pasting tokens by hand.
 *
 * Requires QBO clientId + clientSecret to be set on
 * bcc-integration-qbo.fields BEFORE the connect click. The Intuit redirect
 * URI must be whitelisted in your QBO app's settings:
 *   https://<swa-host>/api/integrations/qbo/callback
 */

app.http('qbo-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const fields = await getIntegrationFields('qbo');
      if (!fields.clientId) {
        return { status: 400, jsonBody: { error: 'Set QBO clientId + clientSecret in Admin first, then click Connect.' } };
      }
      const origin = publicOrigin(request);
      const redirectUri = origin + '/api/integrations/qbo/callback';
      const env = fields.environment === 'production' ? 'production' : 'sandbox';
      const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, env, t: Date.now() })).toString('base64url');
      const authUrl = 'https://appcenter.intuit.com/connect/oauth2?' + new URLSearchParams({
        client_id: fields.clientId,
        response_type: 'code',
        scope: 'com.intuit.quickbooks.accounting',
        redirect_uri: redirectUri,
        state: state
      }).toString();
      // Breadcrumb: the EXACT redirect_uri we send to Intuit (must match a registered URI).
      try {
        await container().items.upsert({ id: 'bcc-qbo-debug-connect', tenantId: BCC_TENANT_ID, docType: 'qbo-debug',
          at: new Date().toISOString(), redirectUri: redirectUri, env: env,
          clientIdTail: String(fields.clientId).slice(-6),
          xMsOriginalUrl: request.headers.get('x-ms-original-url') || null,
          host: request.headers.get('host') || null, xfHost: request.headers.get('x-forwarded-host') || null });
      } catch (_) {}
      return { status: 302, headers: { Location: authUrl } };
    } catch (e) {
      return { status: 500, jsonBody: { error: String(e.message || e) } };
    }
  })
});

app.http('qbo-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const realmId = url.searchParams.get('realmId');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    // Breadcrumb: prove the callback was reached + what Intuit sent back.
    try {
      await container().items.upsert({ id: 'bcc-qbo-debug-callback', tenantId: BCC_TENANT_ID, docType: 'qbo-debug',
        at: new Date().toISOString(), hasCode: !!code, realmId: realmId || null, error: err || null,
        query: (url.search || '').slice(0, 300), xMsOriginalUrl: request.headers.get('x-ms-original-url') || null });
    } catch (_) {}
    if (err) return { status: 302, headers: { Location: '/bookkeeping.html?qbo=' + encodeURIComponent(err) } };
    if (!code || !realmId) return { status: 400, jsonBody: { error: 'missing code or realmId' } };
    try {
      const fields = await getIntegrationFields('qbo');
      if (!fields.clientId || !fields.clientSecret) throw new Error('QBO clientId/clientSecret missing on the integration doc');
      const redirectUri = publicOrigin(request) + '/api/integrations/qbo/callback';
      const basic = Buffer.from(fields.clientId + ':' + fields.clientSecret).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString();
      const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + basic, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const tokText = await r.text();
      if (!r.ok) throw new Error('Intuit token exchange ' + r.status + ' (redirect_uri=' + redirectUri + '): ' + tokText.slice(0, 300));
      const tok = JSON.parse(tokText);

      const env = fields.environment === 'production' ? 'production' : 'sandbox';
      const apiBase = env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
      // Best-effort: fetch the company's display name so the UI lists it nicely.
      let companyName = '';
      try {
        const ci = await fetch(apiBase + '/v3/company/' + encodeURIComponent(realmId) + '/companyinfo/' + encodeURIComponent(realmId) + '?minorversion=70',
          { headers: { Authorization: 'Bearer ' + tok.access_token, Accept: 'application/json' } });
        if (ci.ok) { const cj = await ci.json(); companyName = (cj.CompanyInfo && (cj.CompanyInfo.CompanyName || cj.CompanyInfo.LegalName)) || ''; }
      } catch (_) {}

      const c = container();
      // MULTI-COMPANY: one connection doc per QBO company (realmId). Connecting
      // another company just adds another doc — nothing is overwritten.
      const compId = 'bcc-qbo-company-' + realmId;
      const existing = await c.item(compId, BCC_TENANT_ID).read().then(rr => rr.resource).catch(() => null);
      const comp = existing || { id: compId, tenantId: BCC_TENANT_ID, docType: 'qbo-company', realmId };
      comp.refreshToken = tok.refresh_token;
      comp.environment = env;
      comp.companyName = companyName || comp.companyName || ('Company ' + realmId);
      comp.status = 'connected';
      // Visibility controls (admins manage these): enabled on/off + per-user allow-list.
      if (comp.enabled === undefined) comp.enabled = true;
      if (!Array.isArray(comp.allowedUserUpns)) comp.allowedUserUpns = []; // [] = visible to all users
      comp.connectedAt = comp.connectedAt || new Date().toISOString();
      comp.updatedAt = new Date().toISOString();
      await c.items.upsert(comp);

      // Mark the shared integration row connected (keeps clientId/secret/env).
      const id = 'bcc-integration-qbo';
      const doc = await c.item(id, BCC_TENANT_ID).read().then(rr => rr.resource).catch(() => null);
      const rec = doc || { id, tenantId: BCC_TENANT_ID, docType: 'integration', channel: 'qbo', fields: {} };
      rec.fields = rec.fields || {};
      rec.status = 'connected';
      rec.lastTest = { ok: true, at: new Date().toISOString() };
      rec.updatedAt = new Date().toISOString();
      await c.items.upsert(rec);
      _intCache.until = 0; _intCache.byChannel.clear();

      // Diagnostic breadcrumb (readable from Cosmos): last connect outcome.
      try { await c.items.upsert({ id: 'bcc-qbo-debug', tenantId: BCC_TENANT_ID, docType: 'qbo-debug', at: new Date().toISOString(), step: 'stored', ok: true, realmId, companyName: comp.companyName, redirectUri }); } catch (_) {}

      return { status: 302, headers: { Location: '/bookkeeping.html?qbo=connected&company=' + encodeURIComponent(companyName || realmId) } };
    } catch (e) {
      context.error('qbo callback failed', e);
      try { await container().items.upsert({ id: 'bcc-qbo-debug', tenantId: BCC_TENANT_ID, docType: 'qbo-debug', at: new Date().toISOString(), step: 'error', ok: false, realmId: realmId, error: String(e.message || e) }); } catch (_) {}
      return { status: 302, headers: { Location: '/bookkeeping.html?qbo=error&detail=' + encodeURIComponent(e.message) } };
    }
  })
});

/**
 * GET /api/integrations/qbo/companies
 * Lists connected QBO companies. Admins see ALL companies plus their visibility
 * controls (enabled + allowedUserUpns) and a user directory for assignment.
 * Non-admins see only companies that are enabled AND (visible to all OR include
 * their UPN). Each company carries its most-recent synced period for KPIs.
 */
app.http('qbo-companies', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/companies',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const c = container();
      const { resources: comps } = await c.items.query({
        query: 'SELECT * FROM c WHERE c.tenantId=@t AND c.docType="qbo-company" ORDER BY c.companyName',
        parameters: [{ name: '@t', value: BCC_TENANT_ID }]
      }).fetchAll();
      const { resources: periods } = await c.items.query({
        query: 'SELECT c.realmId, c.period, c.revenueCents, c.expensesCents, c.netCents FROM c WHERE c.tenantId=@t AND c.docType="financial-period"',
        parameters: [{ name: '@t', value: BCC_TENANT_ID }]
      }).fetchAll();
      const latestByRealm = {};
      for (const per of periods) {
        const rid = per.realmId || '_';
        if (!latestByRealm[rid] || (per.period || '') > (latestByRealm[rid].period || '')) latestByRealm[rid] = per;
      }
      const admin = await isAppAdmin(p);
      const who = String(p.userDetails || p.userId || '').toLowerCase();
      let companies = comps.map(co => ({
        realmId: co.realmId, companyName: co.companyName, environment: co.environment,
        status: co.status, connectedAt: co.connectedAt, lastSyncAt: co.lastSyncAt,
        enabled: co.enabled !== false,
        allowedUserUpns: Array.isArray(co.allowedUserUpns) ? co.allowedUserUpns : [],
        latest: latestByRealm[co.realmId] || null
      }));
      if (!admin) {
        // Non-admins: only enabled companies that are visible to everyone or to them.
        companies = companies
          .filter(co => co.enabled && (co.allowedUserUpns.length === 0 || co.allowedUserUpns.map(u => u.toLowerCase()).includes(who)))
          .map(co => { const { allowedUserUpns, ...rest } = co; return rest; });
        return { jsonBody: { isAdmin: false, companies } };
      }
      // Admins: everything + the firm's user directory for the per-user picker.
      const cfg = await getAdminCfg();
      const users = (cfg && Array.isArray(cfg.users) ? cfg.users : [])
        .map(u => ({ upn: (u.upn || u.email || '').toLowerCase(), displayName: u.displayName || u.upn || u.email }))
        .filter(u => u.upn);
      return { jsonBody: { isAdmin: true, companies, users } };
    } catch (err) {
      context.error('qbo-companies error', err);
      return { status: 500, jsonBody: { error: String(err && err.message || err) } };
    }
  })
});

/**
 * POST /api/integrations/qbo/companies/{realmId}   (admin only)
 * Body: { enabled?: bool, allowedUserUpns?: string[] }
 * Turns a company on/off and/or sets which users can see it ([] = everyone).
 */
app.http('qbo-company-update', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/companies/{realmId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    if (!(await isAppAdmin(p))) return { status: 403, jsonBody: { error: 'admin only' } };
    try {
      const realmId = request.params.realmId;
      const body = await request.json().catch(() => ({}));
      const c = container();
      const id = 'bcc-qbo-company-' + realmId;
      const doc = await c.item(id, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      if (!doc) return { status: 404, jsonBody: { error: 'company not found' } };
      if (typeof body.enabled === 'boolean') doc.enabled = body.enabled;
      if (Array.isArray(body.allowedUserUpns)) doc.allowedUserUpns = body.allowedUserUpns.map(s => String(s).toLowerCase()).filter(Boolean);
      doc.updatedAt = new Date().toISOString();
      await c.items.upsert(doc);
      return { jsonBody: { ok: true, realmId, enabled: doc.enabled !== false, allowedUserUpns: doc.allowedUserUpns || [] } };
    } catch (e) {
      context.error('qbo-company-update error', e);
      return { status: 500, jsonBody: { error: String(e.message || e) } };
    }
  })
});

/* ============ QBO live reports (per company) ============
 * One endpoint serves every report/list type for a connected company, minting a
 * fresh access token from the stored refresh token each call. QBO report JSON is
 * flattened to { columns, rows[] } so the UI renders any report uniformly; list
 * types (customers/vendors/invoices/bills) come back as { items[] }.
 */
async function qboAccessForCompany(comp, fields) {
  const basic = Buffer.from(fields.clientId + ':' + fields.clientSecret).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + basic, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: comp.refreshToken }).toString()
  });
  if (!r.ok) throw new Error('QBO token refresh ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200));
  const tok = await r.json();
  if (tok.refresh_token && tok.refresh_token !== comp.refreshToken) { comp.refreshToken = tok.refresh_token; try { await container().items.upsert(comp); } catch (_) {} }
  const env = comp.environment === 'production' ? 'production' : (fields.environment === 'production' ? 'production' : 'sandbox');
  const base = env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
  return { accessToken: tok.access_token, base };
}
// Flatten a QBO report (nested Header/Rows/Summary) into columns + indented rows.
function flattenQboReport(rep) {
  const columns = (((rep || {}).Columns || {}).Column || []).map(c => c.ColTitle || '');
  const rows = [];
  (function walk(rs, level, grp) {
    for (const row of (rs || [])) {
      const g = row.group || grp || null;
      if (row.Header && row.Header.ColData) rows.push({ label: row.Header.ColData[0].value || '', cells: row.Header.ColData.slice(1).map(d => d.value), level, type: 'header', group: g });
      if (row.Rows && row.Rows.Row) walk(row.Rows.Row, level + 1, g);
      if (row.ColData) rows.push({ label: (row.ColData[0] || {}).value || '', cells: row.ColData.slice(1).map(d => d.value), level, type: 'data', group: g });
      if (row.Summary && row.Summary.ColData) rows.push({ label: (row.Summary.ColData[0] || {}).value || '', cells: row.Summary.ColData.slice(1).map(d => d.value), level, type: 'summary', group: row.group || g });
    }
  })(((rep || {}).Rows || {}).Row || [], 0, null);
  return { title: ((rep || {}).Header || {}).ReportName || '', columns, rows };
}
// Sum the numeric value of a flattened report row by its QBO group code (e.g.
// "TotalCurrentAssets"), tolerant of label fallbacks.
function reportNum(s) { const n = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function findByGroup(flat, group) {
  const r = (flat.rows || []).find(x => x.group === group && (x.type === 'summary' || x.type === 'data'));
  return r ? reportNum((r.cells || [])[r.cells.length - 1]) : null;
}
function findByLabel(flat, rx) {
  const r = (flat.rows || []).find(x => rx.test(String(x.label || '')));
  return r ? reportNum((r.cells || [])[r.cells.length - 1]) : null;
}

app.http('qbo-report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/companies/{realmId}/report',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || 'pl').toLowerCase();
    try {
      const c = container();
      const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      if (!comp) return { status: 404, jsonBody: { error: 'company not connected' } };
      // Visibility gate (admins see all; users need access).
      if (!(await isAppAdmin(p))) {
        const who = String(p.userDetails || p.userId || '').toLowerCase();
        const allow = (comp.allowedUserUpns || []).map(u => u.toLowerCase());
        if (comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { status: 403, jsonBody: { error: 'no access to this company' } };
      }
      const fields = await getIntegrationFields('qbo');
      const { accessToken, base } = await qboAccessForCompany(comp, fields);
      const apiGet = async (path) => {
        const u = base + '/v3/company/' + encodeURIComponent(realmId) + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'minorversion=70';
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
        if (!r.ok) throw new Error('QBO ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200));
        return r.json();
      };
      const queryAll = async (sql) => {
        const j = await apiGet('/query?query=' + encodeURIComponent(sql + ' MAXRESULTS 1000'));
        const qr = j.QueryResponse || {}; const k = Object.keys(qr).find(x => Array.isArray(qr[x])); return k ? qr[k] : [];
      };
      const today = new Date().toISOString().slice(0, 10);
      const yStart = today.slice(0, 4) + '-01-01';
      const method = (url.searchParams.get('method') || 'accrual').toLowerCase() === 'cash' ? 'Cash' : 'Accrual';
      let data;
      switch (type) {
        case 'pl': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = flattenQboReport(await apiGet('/reports/ProfitAndLoss?start_date=' + from + '&end_date=' + to + '&accounting_method=' + method));
          data.range = { from, to, method }; data.kind = 'report'; break;
        }
        case 'balancesheet': {
          const asOf = url.searchParams.get('asOf') || today;
          data = flattenQboReport(await apiGet('/reports/BalanceSheet?as_of=' + asOf + '&accounting_method=' + method));
          data.range = { asOf, method }; data.kind = 'report'; break;
        }
        case 'ar-aging': { data = flattenQboReport(await apiGet('/reports/AgedReceivables')); data.kind = 'report'; break; }
        case 'ap-aging': { data = flattenQboReport(await apiGet('/reports/AgedPayables')); data.kind = 'report'; break; }
        case 'customers': { data = { kind: 'list', items: (await queryAll('SELECT Id, DisplayName, Balance, Active FROM Customer')).map(x => ({ name: x.DisplayName, balance: x.Balance, active: x.Active !== false })) }; break; }
        case 'vendors': { data = { kind: 'list', items: (await queryAll('SELECT Id, DisplayName, Balance, Active FROM Vendor')).map(x => ({ name: x.DisplayName, balance: x.Balance, active: x.Active !== false })) }; break; }
        case 'invoices': { data = { kind: 'list', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef FROM Invoice WHERE Balance > '0'")).map(x => ({ doc: x.DocNumber, name: x.CustomerRef && x.CustomerRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance })) }; break; }
        case 'bills': { data = { kind: 'list', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, VendorRef FROM Bill WHERE Balance > '0'")).map(x => ({ doc: x.DocNumber, name: x.VendorRef && x.VendorRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance })) }; break; }
        default: return { status: 400, jsonBody: { error: 'unknown report type "' + type + '"' } };
      }
      return { jsonBody: { type, realmId, companyName: comp.companyName, data } };
    } catch (e) {
      context.error('qbo-report error', e);
      return { status: 502, jsonBody: { error: String(e.message || e) } };
    }
  })
});

/**
 * GET /api/integrations/qbo/companies/{realmId}/kpis?method=&asOf=&burnMonths=
 * Computes headline financial-health KPIs from QBO Balance Sheet + trailing P&L:
 * cash, current ratio, working capital, monthly burn, months of cash (floored),
 * days of cash, revenue/net for the trailing window.
 */
app.http('qbo-kpis', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/companies/{realmId}/kpis',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const url = new URL(request.url);
    try {
      const c = container();
      const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      if (!comp) return { status: 404, jsonBody: { error: 'company not connected' } };
      if (!(await isAppAdmin(p))) {
        const who = String(p.userDetails || p.userId || '').toLowerCase();
        const allow = (comp.allowedUserUpns || []).map(u => u.toLowerCase());
        if (comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { status: 403, jsonBody: { error: 'no access to this company' } };
      }
      const fields = await getIntegrationFields('qbo');
      const { accessToken, base } = await qboAccessForCompany(comp, fields);
      const apiGet = async (path) => {
        const u = base + '/v3/company/' + encodeURIComponent(realmId) + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'minorversion=70';
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
        if (!r.ok) throw new Error('QBO ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200));
        return r.json();
      };
      const method = (url.searchParams.get('method') || 'accrual').toLowerCase() === 'cash' ? 'Cash' : 'Accrual';
      const asOf = url.searchParams.get('asOf') || new Date().toISOString().slice(0, 10);
      const burnMonths = Math.max(1, Math.min(12, parseInt(url.searchParams.get('burnMonths') || '3', 10) || 3));

      const bs = flattenQboReport(await apiGet('/reports/BalanceSheet?as_of=' + asOf + '&accounting_method=' + method));
      const cash = (findByLabel(bs, /total bank account/i) ?? findByLabel(bs, /bank account/i) ?? findByLabel(bs, /checking|savings|cash on hand|^cash$/i)) || 0;
      const currentAssets = (findByGroup(bs, 'TotalCurrentAssets') ?? findByLabel(bs, /total current assets/i)) || 0;
      const currentLiabilities = (findByGroup(bs, 'TotalCurrentLiabilities') ?? findByLabel(bs, /total current liabilities/i)) || 0;
      const totalAssets = (findByLabel(bs, /^total assets/i) ?? findByGroup(bs, 'TotalAssets')) || 0;
      const totalLiabilities = (findByGroup(bs, 'TotalLiabilities') ?? findByLabel(bs, /^total liabilities$/i)) || 0;

      const end = new Date(asOf);
      const start = new Date(end.getFullYear(), end.getMonth() - (burnMonths - 1), 1);
      const from = start.toISOString().slice(0, 10);
      const pl = flattenQboReport(await apiGet('/reports/ProfitAndLoss?start_date=' + from + '&end_date=' + asOf + '&accounting_method=' + method));
      const revenue = (findByGroup(pl, 'Income') ?? findByLabel(pl, /total income/i)) || 0;
      const cogs = (findByGroup(pl, 'COGS') ?? findByLabel(pl, /total cost of goods sold|total cogs/i)) || 0;
      const opex = (findByGroup(pl, 'Expenses') ?? findByLabel(pl, /total expenses/i)) || 0;
      const netIncome = (findByGroup(pl, 'NetIncome') ?? (revenue - cogs - opex));
      const expenses = cogs + opex;
      const monthlyBurn = expenses / burnMonths;

      const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null;
      const workingCapital = currentAssets - currentLiabilities;
      const monthsOfCash = monthlyBurn > 0 ? Math.floor(cash / monthlyBurn) : null;
      const daysOfCash = monthlyBurn > 0 ? Math.round((cash / monthlyBurn) * 30) : null;

      return { jsonBody: {
        realmId, companyName: comp.companyName, asOf, method, burnMonths,
        kpis: {
          cash, currentAssets, currentLiabilities, currentRatio, workingCapital,
          monthlyBurn, monthsOfCash, daysOfCash,
          revenue, cogs, opex, expenses, netIncome,
          netMargin: revenue ? netIncome / revenue : null,
          totalAssets, totalLiabilities
        }
      } };
    } catch (e) {
      context.error('qbo-kpis error', e);
      return { status: 502, jsonBody: { error: String(e.message || e) } };
    }
  })
});

/* ============ Marketing OAuth: Google Ads, LinkedIn, Meta, Mailchimp ============
 *
 * Same pattern as QBO above (UI-pasted clientId / clientSecret on the
 * bcc-integration-<channel> doc, NOT env vars), so a non-developer admin
 * can point each connector at their own dev app from the UI.
 *
 * Each provider has two routes:
 *   GET /api/integrations/<channel>/connect    -> 302 to provider authorize
 *   GET /api/integrations/<channel>/callback   -> exchanges code, stores
 *                                                  refreshToken (or long-
 *                                                  lived accessToken) on
 *                                                  the doc, flips status,
 *                                                  302s back to admin.html
 *
 * Setup docs: docs/oauth-setup.md walks through the dev portal for each.
 */

// Persist a successful OAuth exchange to bcc-integration-<channel>.fields
async function saveOAuthTokens(channel, patch) {
  const c = container();
  const id = 'bcc-integration-' + channel;
  const doc = await c.item(id, BCC_TENANT_ID).read().then(rr => rr.resource).catch(() => null);
  const rec = doc || { id, tenantId: BCC_TENANT_ID, docType: 'integration', channel, fields: {} };
  rec.fields = Object.assign(rec.fields || {}, patch);
  rec.status = 'connected';
  rec.lastTest = { ok: true, at: new Date().toISOString() };
  rec.updatedAt = new Date().toISOString();
  await c.items.upsert(rec);
  _intCache.until = 0; _intCache.byChannel.clear();
}

// Generic builder: if fields are missing, return a friendly 400 instead of
// redirecting the user to a confusing provider error page.
async function requireIntegrationFields(channel, required) {
  const fields = await getIntegrationFields(channel);
  const missing = required.filter(k => !fields[k]);
  if (missing.length) {
    return { missing, fields: null };
  }
  return { missing: null, fields };
}

/* ---- Google Ads ---- */
app.http('googleads-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/google-ads/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const r = await requireIntegrationFields('google-ads', ['clientId', 'clientSecret']);
    if (r.missing) {
      return { status: 400, jsonBody: { error: 'Set Google Ads clientId + clientSecret in Admin → Integrations first.', missing: r.missing } };
    }
    const origin = publicOrigin(request);
    const redirectUri = origin + '/api/integrations/google-ads/callback';
    const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, t: Date.now() })).toString('base64url');
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: r.fields.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline',
      prompt: 'consent',
      state: state
    }).toString();
    return { status: 302, headers: { Location: authUrl } };
  })
});

app.http('googleads-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/google-ads/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return { status: 302, headers: { Location: '/admin.html?google-ads=' + encodeURIComponent(err) + '#integrations' } };
    if (!code) return { status: 400, jsonBody: { error: 'missing code' } };
    try {
      const fields = await getIntegrationFields('google-ads');
      const redirectUri = publicOrigin(request) + '/api/integrations/google-ads/callback';
      const body = new URLSearchParams({
        code,
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString();
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
      });
      if (!tr.ok) throw new Error('Google token exchange ' + tr.status + ': ' + (await tr.text()).slice(0, 200));
      const tok = await tr.json();
      if (!tok.refresh_token) throw new Error('Google did not return a refresh_token (re-consent with prompt=consent&access_type=offline)');
      await saveOAuthTokens('google-ads', { refreshToken: tok.refresh_token });
      return { status: 302, headers: { Location: '/admin.html?google-ads=connected#integrations' } };
    } catch (e) {
      context.error('google-ads callback failed', e);
      return { status: 302, headers: { Location: '/admin.html?google-ads=error&detail=' + encodeURIComponent(e.message) + '#integrations' } };
    }
  })
});

/* ---- LinkedIn ---- */
app.http('linkedin-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/linkedin/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const r = await requireIntegrationFields('linkedin', ['clientId', 'clientSecret']);
    if (r.missing) {
      return { status: 400, jsonBody: { error: 'Set LinkedIn clientId + clientSecret in Admin → Integrations first.', missing: r.missing } };
    }
    const origin = publicOrigin(request);
    const redirectUri = origin + '/api/integrations/linkedin/callback';
    const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, t: Date.now() })).toString('base64url');
    // r_ads + r_ads_reporting require Marketing Developer Platform access.
    // r_basicprofile/email work for any new app without extra approval.
    const scope = (r.fields.scope || 'r_organization_social r_ads r_ads_reporting r_emailaddress').trim();
    const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
      response_type: 'code',
      client_id: r.fields.clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: scope
    }).toString();
    return { status: 302, headers: { Location: authUrl } };
  })
});

app.http('linkedin-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/linkedin/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return { status: 302, headers: { Location: '/admin.html?linkedin=' + encodeURIComponent(err) + '#integrations' } };
    if (!code) return { status: 400, jsonBody: { error: 'missing code' } };
    try {
      const fields = await getIntegrationFields('linkedin');
      const redirectUri = publicOrigin(request) + '/api/integrations/linkedin/callback';
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: fields.clientId,
        client_secret: fields.clientSecret
      }).toString();
      const tr = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
      });
      if (!tr.ok) throw new Error('LinkedIn token exchange ' + tr.status + ': ' + (await tr.text()).slice(0, 200));
      const tok = await tr.json();
      // LinkedIn issues 60-day access tokens. Marketing Developer Platform
      // apps additionally get refresh_token for token rotation.
      const patch = {
        accessToken:  tok.access_token,
        expiresInSec: tok.expires_in
      };
      if (tok.refresh_token) patch.refreshToken = tok.refresh_token;
      await saveOAuthTokens('linkedin', patch);
      return { status: 302, headers: { Location: '/admin.html?linkedin=connected#integrations' } };
    } catch (e) {
      context.error('linkedin callback failed', e);
      return { status: 302, headers: { Location: '/admin.html?linkedin=error&detail=' + encodeURIComponent(e.message) + '#integrations' } };
    }
  })
});

/* ---- Meta (Facebook Ads + Instagram) ---- */
app.http('meta-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/meta/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const r = await requireIntegrationFields('meta', ['clientId', 'clientSecret']);
    if (r.missing) {
      return { status: 400, jsonBody: { error: 'Set Meta clientId + clientSecret in Admin → Integrations first.', missing: r.missing } };
    }
    const origin = publicOrigin(request);
    const redirectUri = origin + '/api/integrations/meta/callback';
    const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, t: Date.now() })).toString('base64url');
    const scope = (r.fields.scope || 'ads_read,business_management,read_insights,pages_read_engagement').trim();
    const authUrl = 'https://www.facebook.com/v18.0/dialog/oauth?' + new URLSearchParams({
      client_id: r.fields.clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: scope,
      response_type: 'code'
    }).toString();
    return { status: 302, headers: { Location: authUrl } };
  })
});

app.http('meta-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/meta/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return { status: 302, headers: { Location: '/admin.html?meta=' + encodeURIComponent(err) + '#integrations' } };
    if (!code) return { status: 400, jsonBody: { error: 'missing code' } };
    try {
      const fields = await getIntegrationFields('meta');
      const redirectUri = publicOrigin(request) + '/api/integrations/meta/callback';
      // 1) Exchange code for short-lived access token
      const tr1 = await fetch('https://graph.facebook.com/v18.0/oauth/access_token?' + new URLSearchParams({
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
        redirect_uri: redirectUri,
        code
      }).toString());
      if (!tr1.ok) throw new Error('Meta token exchange ' + tr1.status + ': ' + (await tr1.text()).slice(0, 200));
      const t1 = await tr1.json();
      // 2) Exchange short-lived for long-lived (60 days)
      const tr2 = await fetch('https://graph.facebook.com/v18.0/oauth/access_token?' + new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
        fb_exchange_token: t1.access_token
      }).toString());
      if (!tr2.ok) throw new Error('Meta long-lived exchange ' + tr2.status + ': ' + (await tr2.text()).slice(0, 200));
      const t2 = await tr2.json();
      await saveOAuthTokens('meta', {
        accessToken: t2.access_token,
        expiresInSec: t2.expires_in
      });
      return { status: 302, headers: { Location: '/admin.html?meta=connected#integrations' } };
    } catch (e) {
      context.error('meta callback failed', e);
      return { status: 302, headers: { Location: '/admin.html?meta=error&detail=' + encodeURIComponent(e.message) + '#integrations' } };
    }
  })
});

/* ---- Mailchimp ---- */
app.http('mailchimp-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/mailchimp/connect',
  handler: withAccessLog(async (request) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const r = await requireIntegrationFields('mailchimp', ['clientId', 'clientSecret']);
    if (r.missing) {
      return { status: 400, jsonBody: { error: 'Set Mailchimp clientId + clientSecret in Admin → Integrations first.', missing: r.missing } };
    }
    const origin = publicOrigin(request);
    const redirectUri = origin + '/api/integrations/mailchimp/callback';
    const state = Buffer.from(JSON.stringify({ upn: p.userDetails || p.userId, t: Date.now() })).toString('base64url');
    const authUrl = 'https://login.mailchimp.com/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: r.fields.clientId,
      redirect_uri: redirectUri,
      state: state
    }).toString();
    return { status: 302, headers: { Location: authUrl } };
  })
});

app.http('mailchimp-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/mailchimp/callback',
  handler: withAccessLog(async (request, context) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return { status: 302, headers: { Location: '/admin.html?mailchimp=' + encodeURIComponent(err) + '#integrations' } };
    if (!code) return { status: 400, jsonBody: { error: 'missing code' } };
    try {
      const fields = await getIntegrationFields('mailchimp');
      const redirectUri = publicOrigin(request) + '/api/integrations/mailchimp/callback';
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
        redirect_uri: redirectUri,
        code
      }).toString();
      const tr = await fetch('https://login.mailchimp.com/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
      });
      if (!tr.ok) throw new Error('Mailchimp token exchange ' + tr.status + ': ' + (await tr.text()).slice(0, 200));
      const tok = await tr.json();
      // Mailchimp tokens are long-lived; metadata gives us the data-center
      // prefix needed for every subsequent API call (e.g. us21).
      const mr = await fetch('https://login.mailchimp.com/oauth2/metadata', {
        headers: { Authorization: 'OAuth ' + tok.access_token }
      });
      if (!mr.ok) throw new Error('Mailchimp metadata ' + mr.status);
      const meta = await mr.json();
      await saveOAuthTokens('mailchimp', {
        accessToken:  tok.access_token,
        dc:           meta.dc,
        apiEndpoint:  meta.api_endpoint,
        accountId:    meta.user_id || meta.account_id,
        accountName:  meta.accountname || meta.login && meta.login.login_name
      });
      return { status: 302, headers: { Location: '/admin.html?mailchimp=connected#integrations' } };
    } catch (e) {
      context.error('mailchimp callback failed', e);
      return { status: 302, headers: { Location: '/admin.html?mailchimp=error&detail=' + encodeURIComponent(e.message) + '#integrations' } };
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
      const linkedContactId    = String(form.get('linkedContactId') || '').trim() || null;
      const linkedEngagementId = String(form.get('linkedEngagementId') || '').trim() || null;

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
        linkedContactId: linkedContactId,
        linkedEngagementId: linkedEngagementId,
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

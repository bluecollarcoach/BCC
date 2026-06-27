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
const crypto = require('crypto');

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
// Docs managed exclusively by dedicated, access-gated endpoints — OAuth refresh
// tokens (bcc-qbo-company-*, bcc-clientdrive-*), per-client mailbox config, and
// server-only time. The generic /api/data path must NEVER create, overwrite, or
// delete these (they each have an admin/allow-list-gated endpoint of their own).
const PROTECTED_KEY_PREFIXES = ['bcc-qbo-company-', 'bcc-client-mailbox-', 'bcc-clientdrive-', 'bcc-bktime-', 'bcc-emailmeta-'];
function isProtectedServerKey(k) { return PROTECTED_KEY_PREFIXES.some(pre => String(k || '').startsWith(pre)); }
// Content types we'll serve INLINE for in-app preview. Deliberately excludes
// text/html + svg + xhtml (active content) so an uploaded page can't render and
// run script — those always download instead.
function inlineOk(ct) {
  ct = String(ct || '').toLowerCase().split(';')[0].trim();
  if (ct === 'text/html' || ct === 'image/svg+xml' || ct === 'application/xhtml+xml') return false;
  return /^image\//.test(ct) || ct === 'application/pdf' || ct === 'text/plain' || ct === 'text/csv';
}

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
// Strip credential-looking fields from an integration doc for non-admins, while
// keeping non-secret status flags (e.g. status:'connected') so UI badges still work.
const SECRET_FIELD_RE = /secret|token|password|connection|webhook|privatekey|apikey|(^|[^a-z])key([^a-z]|$)/i;
function redactIntegrationData(data) {
  if (!data || typeof data !== 'object') return data;
  const out = Object.assign({}, data);
  if (out.fields && typeof out.fields === 'object') {
    const f = {};
    for (const k of Object.keys(out.fields)) f[k] = SECRET_FIELD_RE.test(k) ? '' : out.fields[k];
    out.fields = f;
  }
  return out;
}

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
          // Integration docs hold OAuth client secrets / tokens — redact for non-admins.
          const keyRedact = key.startsWith('bcc-integration-') && !(await isAppAdmin(p));
          try {
            const { resource } = await c.item(key, BCC_TENANT_ID).read();
            const data = resource ? (keyRedact ? redactIntegrationData(resource.data) : resource.data) : null;
            return { jsonBody: { key, data, updatedAt: resource && resource.updatedAt, updatedBy: resource && resource.updatedBy } };
          } catch (e) {
            if (e.code === 404) return { jsonBody: { key, data: null } };
            throw e;
          }
        }
        const q = {
          // Exclude server-only time docs so their ids (which encode who worked
          // which client on which day) aren't shipped to every signed-in user.
          query: 'SELECT c.id, c.data, c.updatedAt, c.updatedBy FROM c WHERE c.tenantId = @t AND STARTSWITH(c.id, "bcc-") AND (NOT IS_DEFINED(c.docType) OR (c.docType != "bk-time" AND c.docType != "client-drive"))',
          parameters: [{ name: '@t', value: BCC_TENANT_ID }]
        };
        const { resources } = await c.items.query(q).fetchAll();
        // Integration docs hold secrets — redact credential fields for non-admins
        // (status flags stay so connection badges keep working).
        const dataAdmin = await isAppAdmin(p);
        const items = resources.map(r => {
          const isInt = String(r.id).startsWith('bcc-integration-');
          return { key: r.id, data: (isInt && !dataAdmin) ? redactIntegrationData(r.data) : r.data, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
        });
        return { jsonBody: { items } };
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
          if (isProtectedServerKey(it.key)) return forbidden('this record is managed by a secure endpoint and cannot be written here');
          if (ADMIN_KEYS.has(it.key)) touchesAdminKey = true;
          if (it.key.startsWith('bcc-integration-')) touchesIntegration = true;
        }
        if (touchesAdminKey && !(await isAppAdmin(p))) {
          return forbidden('only administrators may write admin config');
        }
        if (touchesIntegration && !(await isAppAdmin(p))) {
          return forbidden('only administrators may write integration credentials');
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
        if (isProtectedServerKey(key)) return forbidden('this record is managed by a secure endpoint and cannot be deleted here');
        if (ADMIN_KEYS.has(key) && !(await isAppAdmin(p))) return forbidden();
        if (key.startsWith('bcc-integration-') && !(await isAppAdmin(p))) return forbidden('only administrators may delete integration credentials');
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
  'activity-unlock', 'activity-unlock-failed',
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
  'issue-report',
  // Bookkeeping client workspace (were being rejected → not recorded)
  'qbo-write', 'qbo-attach',
  'client-info-update', 'client-mailbox-set',
  'client-task-create', 'client-task-delete',
  'time-punch-in', 'time-punch-out', 'time-entry-add', 'time-entry-delete',
  'client-email-send', 'client-file-upload', 'client-file-delete',
  'cpr-save', 'cpr-delete', 'cpr-print',
  'financial-period-save', 'financial-period-delete',
  // Other recently-added events that were also being rejected
  'chat-members-update', 'dashboard-update', 'permissions-update',
  'user-add', 'user-remove', 'job-create'
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
      // Firm-wide activity (every user's actions, IPs, paths) is admin-only — the
      // client-side passphrase is not a server-side control. Per-client activity
      // for bookkeepers goes through the access-gated /api/audit/client/{realmId}.
      if (!(await isAppAdmin(p))) return forbidden('admin only');
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

/* ============ Bookkeeping auto time tracking ============
 * Bookkeepers (users whose admin-config landingPage is bookkeeping.html) have
 * their active time-on-client recorded automatically by bookkeeping.html, which
 * POSTs accrued seconds here. Stored per user/client/day (bcc-bktime-*), and
 * surfaced to admins via the report endpoint (Admin → Bookkeeping time).
 */
app.http('bookkeeping-time', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'bookkeeping/time',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const who = String(p.userDetails || p.userId || '').toLowerCase();
      // Enforce the "bookkeeper = default landing is Bookkeeping" rule server-side.
      const cfg = await getAdminCfg();
      const rec = (cfg && Array.isArray(cfg.users) ? cfg.users : []).find(u =>
        (u.upn || '').toLowerCase() === who || (u.email || '').toLowerCase() === who);
      if (!rec || rec.landingPage !== 'bookkeeping.html') return { jsonBody: { ok: true, recorded: 0, skipped: 'not a bookkeeper' } };

      const b = await request.json().catch(() => ({}));
      const entries = Array.isArray(b.entries) ? b.entries : [];
      if (!entries.length) return { jsonBody: { ok: true, recorded: 0 } };
      const c = container();
      const name = p.userDetails || who;
      // Business-timezone (US Central) day bucket so evening work bins to the
      // correct local day/month rather than UTC.
      let day;
      try { day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); } catch (e) { day = new Date().toISOString().slice(0, 10); }
      const DAILY_CAP = 16 * 3600; // realistic per-client/day ceiling (anti-inflation)
      let recorded = 0;
      for (const e of entries) {
        const realmId = String(e.realmId || ''); if (!realmId) continue;
        let secs = Math.round(Number(e.seconds) || 0);
        if (!(secs > 0)) continue;
        if (secs > 3600) secs = 3600; // per-beat cap (clock jumps)
        const id = 'bcc-bktime-' + sanitizeUpn(who) + '-' + realmId + '-' + day;
        // Optimistic-concurrency add so overlapping flushes (multiple tabs, or an
        // unload beacon racing a keepalive fetch) can't silently lose increments.
        for (let attempt = 0; attempt < 5; attempt++) {
          let existing = null;
          try { const r = await c.item(id, BCC_TENANT_ID).read(); existing = r.resource; }
          catch (re) { if (re.code !== 404) throw re; }
          const doc = existing || { id, tenantId: BCC_TENANT_ID, docType: 'bk-time', userUpn: who, userName: name, realmId, companyName: String(e.companyName || ''), day, seconds: 0, createdAt: new Date().toISOString() };
          doc.seconds = Math.min((doc.seconds || 0) + secs, DAILY_CAP);
          if (e.companyName) doc.companyName = String(e.companyName);
          doc.userName = name; doc.updatedAt = new Date().toISOString();
          try {
            if (existing && existing._etag) await c.item(id, BCC_TENANT_ID).replace(doc, { accessCondition: { type: 'IfMatch', condition: existing._etag } });
            else await c.items.create(doc);
            break;
          } catch (we) {
            if ((we.code === 412 || we.code === 409) && attempt < 4) continue; // concurrent write — re-read and retry
            throw we;
          }
        }
        recorded += secs;
      }
      return { jsonBody: { ok: true, recorded } };
    } catch (err) { context.error('bookkeeping-time', err); return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } }; }
  })
});

app.http('bookkeeping-time-report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'bookkeeping/time/report',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    if (!(await isAppAdmin(p))) return { status: 403, jsonBody: { ok: false, error: 'admin only' } };
    try {
      const u = new URL(request.url);
      const from = u.searchParams.get('from') || '0000-00-00';
      const to = u.searchParams.get('to') || '9999-99-99';
      const c = container();
      const { resources } = await c.items.query({
        query: 'SELECT c.userUpn, c.userName, c.realmId, c.companyName, c.day, c.seconds FROM c WHERE c.tenantId=@t AND c.docType="bk-time" AND c.day>=@f AND c.day<=@to',
        parameters: [{ name: '@t', value: BCC_TENANT_ID }, { name: '@f', value: from }, { name: '@to', value: to }]
      }).fetchAll();
      const byCompany = {}, byUser = {};
      for (const r of resources) {
        const s = r.seconds || 0;
        const cc = byCompany[r.realmId] || (byCompany[r.realmId] = { realmId: r.realmId, companyName: r.companyName || r.realmId, seconds: 0, users: {} });
        cc.seconds += s; cc.users[r.userUpn] = (cc.users[r.userUpn] || 0) + s;
        if (r.companyName) cc.companyName = r.companyName;
        const uu = byUser[r.userUpn] || (byUser[r.userUpn] = { userUpn: r.userUpn, userName: r.userName || r.userUpn, seconds: 0 });
        uu.seconds += s; if (r.userName) uu.userName = r.userName;
      }
      const companies = Object.keys(byCompany).map(k => { const x = byCompany[k]; return { realmId: x.realmId, companyName: x.companyName, seconds: x.seconds, users: Object.keys(x.users).map(u2 => ({ userUpn: u2, seconds: x.users[u2] })).sort((a, b) => b.seconds - a.seconds) }; }).sort((a, b) => b.seconds - a.seconds);
      const users = Object.keys(byUser).map(k => byUser[k]).sort((a, b) => b.seconds - a.seconds);
      return { jsonBody: { ok: true, from, to, companies, users } };
    } catch (err) { context.error('bookkeeping-time-report', err); return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } }; }
  })
});

/* ============ Per-client cloud drive linking (Google Drive / OneDrive) ============
 * Each client can link the firm to THEIR drive (a login the client provisions for
 * us). We store a per-client OAuth refresh token (bcc-clientdrive-<realmId>) and
 * browse / download / upload the shared files inside the bookkeeping Files section.
 * Firm OAuth app creds: Google via Admin → Integrations (google-drive clientId/
 * secret); Microsoft via ONEDRIVE_CLIENT_ID/SECRET + ONEDRIVE_TENANT app settings
 * (a dedicated multi-tenant Entra app). All token secrets stay server-side.
 */
const MS_DRIVE_SCOPE = 'offline_access Files.ReadWrite User.Read';
// The Google provider key is 'google' but its route segment is 'google-drive';
// the redirect_uri MUST match the registered callback route, so map it.
function driveRouteSeg(provider) { return provider === 'google' ? 'google-drive' : provider; }
function driveRedirect(request, provider) { return publicOrigin(request) + '/api/integrations/' + driveRouteSeg(provider) + '/callback'; }
function driveStateSecret() { return process.env.CRON_SECRET || process.env.AZURE_CLIENT_SECRET || process.env.COSMOS_KEY || 'bcc-drive-state'; }
// Sign the OAuth state so it carries the realmId + the initiating user, tamper-proof.
function driveSignState(realmId, uid) {
  const payload = String(realmId) + '.' + Buffer.from(String(uid || '')).toString('base64url') + '.' + Date.now();
  const sig = crypto.createHmac('sha256', driveStateSecret()).update(payload).digest('base64url').slice(0, 24);
  return Buffer.from(payload + '.' + sig).toString('base64url');
}
function driveVerifyState(state, uid) {
  try {
    const parts = Buffer.from(String(state || ''), 'base64url').toString().split('.');
    if (parts.length < 4) return null;
    const sig = parts.pop();
    const payload = parts.join('.');
    const expect = crypto.createHmac('sha256', driveStateSecret()).update(payload).digest('base64url').slice(0, 24);
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const realmId = parts[0];
    const stateUid = Buffer.from(parts[1], 'base64url').toString();
    const ts = Number(parts[2]);
    if (!realmId || !ts || (Date.now() - ts) > 15 * 60 * 1000) return null;
    if (uid && stateUid && String(uid).toLowerCase() !== stateUid.toLowerCase()) return null;
    return { realmId: realmId, uid: stateUid };
  } catch (e) { return null; }
}
// Generic tamper-proof OAuth state for the QBO + MS Graph callbacks: HMAC-sign a
// small JSON payload ({upn,env,t}) so a callback can't be forged or replayed and
// the saved token is bound to the user who started the flow.
function signOAuthState(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', driveStateSecret()).update(body).digest('base64url').slice(0, 24);
  return body + '.' + sig;
}
function verifyOAuthState(state) {
  try {
    const s = String(state || ''); const i = s.lastIndexOf('.');
    if (i < 1) return null;
    const body = s.slice(0, i), sig = s.slice(i + 1);
    const expect = crypto.createHmac('sha256', driveStateSecret()).update(body).digest('base64url').slice(0, 24);
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!obj || !obj.t || (Date.now() - Number(obj.t)) > 15 * 60 * 1000) return null;
    return obj;
  } catch (e) { return null; }
}
function driveBack(realmId, msg) { return { status: 302, headers: { Location: '/bookkeeping.html?drive=' + (msg ? 'error' : 'connected') + (realmId ? ('&realmId=' + encodeURIComponent(realmId)) : '') + (msg ? ('&detail=' + encodeURIComponent(String(msg).slice(0, 120))) : '') } }; }
async function driveAppCreds(provider) {
  if (provider === 'google') { const f = await getIntegrationFields('google-drive'); const id = f.clientId || f.client_id, secret = f.clientSecret || f.client_secret; return { provider, clientId: id, clientSecret: secret, ok: !!(id && secret) }; }
  if (provider === 'onedrive') { return { provider, clientId: process.env.ONEDRIVE_CLIENT_ID, clientSecret: process.env.ONEDRIVE_CLIENT_SECRET, tenant: process.env.ONEDRIVE_TENANT || 'common', ok: !!(process.env.ONEDRIVE_CLIENT_ID && process.env.ONEDRIVE_CLIENT_SECRET) }; }
  return { provider, ok: false };
}
async function driveClientAccess(p, realmId) {
  const c = container();
  const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  if (!(await isAppAdmin(p))) {
    const who = String(p.userDetails || p.userId || '').toLowerCase();
    const allow = ((comp && comp.allowedUserUpns) || []).map(u => String(u).toLowerCase());
    if (!comp || comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { err: { status: 403, jsonBody: { ok: false, error: 'no access to this client' } } };
  }
  return { comp };
}
function driveTokenUrl(creds) { return creds.provider === 'google' ? 'https://oauth2.googleapis.com/token' : ('https://login.microsoftonline.com/' + creds.tenant + '/oauth2/v2.0/token'); }
async function driveExchangeCode(creds, code, redirect) {
  const params = { client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirect, code, grant_type: 'authorization_code' };
  if (creds.provider === 'onedrive') params.scope = MS_DRIVE_SCOPE;
  const r = await fetch(driveTokenUrl(creds), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  if (!r.ok) throw new Error('token exchange ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
  return r.json();
}
async function driveAccessToken(doc, creds) {
  const params = { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: doc.refreshToken, grant_type: 'refresh_token' };
  if (creds.provider === 'onedrive') params.scope = MS_DRIVE_SCOPE;
  const r = await fetch(driveTokenUrl(creds), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  if (!r.ok) throw new Error('token refresh ' + r.status);
  const j = await r.json();
  if (j.refresh_token && j.refresh_token !== doc.refreshToken) { doc.refreshToken = j.refresh_token; try { await container().items.upsert(doc); } catch (_) {} }
  return j.access_token;
}
function driveConnectHandler(provider) {
  return async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = new URL(request.url).searchParams.get('realmId');
    if (!realmId) return driveBack(null, 'missing client');
    const acc = await driveClientAccess(p, realmId); if (acc.err) return driveBack(realmId, 'no access to this client');
    const creds = await driveAppCreds(provider); if (!creds.ok) return driveBack(realmId, (provider === 'google' ? 'Google Drive' : 'OneDrive') + ' app not configured yet');
    const redirect = driveRedirect(request, provider);
    const state = driveSignState(realmId, p.userDetails || p.userId || '');
    let url;
    if (provider === 'google') url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive openid email', access_type: 'offline', prompt: 'consent', state }).toString();
    else url = 'https://login.microsoftonline.com/' + creds.tenant + '/oauth2/v2.0/authorize?' + new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: MS_DRIVE_SCOPE, prompt: 'select_account', state }).toString();
    return { status: 302, headers: { Location: url } };
  };
}
function driveCallbackHandler(provider) {
  return async (request, context) => {
    const p = principal(request);
    const u = new URL(request.url);
    const code = u.searchParams.get('code'); const rawState = u.searchParams.get('state'); const oerr = u.searchParams.get('error');
    try {
      if (oerr) return driveBack(null, oerr);
      // The SWA principal is usually ABSENT on the cross-site redirect back from
      // Google/Microsoft, so we don't require it. The HMAC-signed state is the
      // gate: it can't be forged, expires in 15 min, and is only minted by the
      // /connect endpoint AFTER that endpoint verified the caller's access to the
      // client. If a principal IS present, we additionally bind it to the state.
      const st = driveVerifyState(rawState, p ? (p.userDetails || p.userId || '') : '');
      if (!code || !st || !st.realmId) return driveBack(null, 'invalid or expired sign-in — start the connect again');
      const realmId = st.realmId;
      const creds = await driveAppCreds(provider); if (!creds.ok) return driveBack(realmId, 'app not configured');
      const tok = await driveExchangeCode(creds, code, driveRedirect(request, provider));
      if (!tok.refresh_token) return driveBack(realmId, 'no refresh token returned — re-consent');
      let account = '';
      try {
        if (provider === 'google') { const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } }).then(r => r.json()); account = ui.email || ''; }
        else { const me = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + tok.access_token } }).then(r => r.json()); account = me.userPrincipalName || me.mail || ''; }
      } catch (_) {}
      const connectedBy = String((p && (p.userDetails || p.userId)) || st.uid || '').toLowerCase();
      await container().items.upsert({ id: 'bcc-clientdrive-' + realmId, tenantId: BCC_TENANT_ID, docType: 'client-drive', realmId, provider, account, refreshToken: tok.refresh_token, connectedAt: new Date().toISOString(), connectedBy });
      return driveBack(realmId, null);
    } catch (e) { context.error('drive-callback', e); return driveBack(null, String(e && e.message || e)); }
  };
}
app.http('google-drive-connect',  { methods: ['GET'], authLevel: 'anonymous', route: 'integrations/google-drive/connect',  handler: withAccessLog(driveConnectHandler('google')) });
app.http('google-drive-callback', { methods: ['GET'], authLevel: 'anonymous', route: 'integrations/google-drive/callback', handler: withAccessLog(driveCallbackHandler('google')) });
app.http('onedrive-connect',      { methods: ['GET'], authLevel: 'anonymous', route: 'integrations/onedrive/connect',      handler: withAccessLog(driveConnectHandler('onedrive')) });
app.http('onedrive-callback',     { methods: ['GET'], authLevel: 'anonymous', route: 'integrations/onedrive/callback',     handler: withAccessLog(driveCallbackHandler('onedrive')) });

// Status (+ DELETE to disconnect). connected/provider/account + whether each app is configured.
app.http('drive-status', {
  methods: ['GET', 'DELETE'], authLevel: 'anonymous', route: 'integrations/drive/{realmId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const acc = await driveClientAccess(p, realmId); if (acc.err) return acc.err;
    const c = container(); const id = 'bcc-clientdrive-' + realmId;
    if (request.method === 'DELETE') { try { await c.item(id, BCC_TENANT_ID).delete(); } catch (e) { if (e.code !== 404) throw e; } return { jsonBody: { ok: true, connected: false } }; }
    const doc = await c.item(id, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
    return { jsonBody: { ok: true, connected: !!doc, provider: doc ? doc.provider : null, account: doc ? doc.account : null, rootName: (doc && doc.root && doc.root.name) || null, googleConfigured: (await driveAppCreds('google')).ok, onedriveConfigured: (await driveAppCreds('onedrive')).ok } };
  })
});

// Encode a Microsoft sharing URL into the /shares share id (lets us read a folder
// the client shared with us even when our account has no OneDrive of its own).
function msShareId(url) { const b64 = Buffer.from(String(url || ''), 'utf8').toString('base64'); return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-'); }
function googleFolderId(s) { s = String(s || '').trim(); const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/) || s.match(/\/d\/([\w-]+)/); if (m) return m[1]; if (/^[\w-]{12,}$/.test(s)) return s; return ''; }

// Set/clear the per-client "landing folder" — the folder the browser opens in.
// Required for OneDrive when the client SHARES a folder with our account (that
// account often has no personal OneDrive, so we reach the folder via /shares).
app.http('drive-set-root', {
  methods: ['POST'], authLevel: 'anonymous', route: 'integrations/drive/{realmId}/root',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const acc = await driveClientAccess(p, realmId); if (acc.err) return acc.err;
    try {
      const dt = await driveDocAndToken(realmId); if (dt.err) return dt.err;
      const b = await request.json().catch(() => ({}));
      const c = container();
      if (b.clear) { delete dt.doc.root; await c.items.upsert(dt.doc); return { jsonBody: { ok: true, root: null } }; }
      const link = String(b.link || '').trim();
      if (!link) return badRequest('paste the shared-folder link');
      let root;
      if (dt.doc.provider === 'onedrive') {
        const r = await fetch('https://graph.microsoft.com/v1.0/shares/' + msShareId(link) + '/driveItem?$select=id,name,parentReference,folder', { headers: { Authorization: 'Bearer ' + dt.at } });
        if (!r.ok) return { status: 400, jsonBody: { ok: false, error: 'Could not open that link (' + r.status + '). Make sure it was shared with ' + (dt.doc.account || 'this account') + ' and points to a folder.' } };
        const di = await r.json();
        if (!di.folder) return badRequest('that link points to a file, not a folder');
        if (!di.parentReference || !di.parentReference.driveId) return badRequest('could not resolve that folder');
        root = { driveId: di.parentReference.driveId, itemId: di.id, name: di.name || 'Shared folder' };
      } else {
        const fid = googleFolderId(link);
        if (!fid) return badRequest('could not find a folder id in that link');
        const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fid) + '?fields=id,name,mimeType&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + dt.at } });
        if (!r.ok) return { status: 400, jsonBody: { ok: false, error: 'Could not open that folder (' + r.status + '). Make sure it is shared with ' + (dt.doc.account || 'this account') + '.' } };
        const f = await r.json();
        if (f.mimeType !== 'application/vnd.google-apps.folder') return badRequest('that link is not a folder');
        root = { folderId: f.id, name: f.name || 'Shared folder' };
      }
      dt.doc.root = root;
      await c.items.upsert(dt.doc);
      return { jsonBody: { ok: true, root: { name: root.name } } };
    } catch (e) { context.error('drive-set-root', e); return { status: 502, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

async function driveDocAndToken(realmId) {
  const c = container();
  const doc = await c.item('bcc-clientdrive-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  if (!doc) return { err: { status: 400, jsonBody: { ok: false, error: 'not connected' } } };
  const creds = await driveAppCreds(doc.provider);
  if (!creds.ok) return { err: { status: 400, jsonBody: { ok: false, error: 'app not configured' } } };
  const at = await driveAccessToken(doc, creds);
  return { doc, at };
}

// List files in the client's drive (root or a folder).
app.http('drive-files', {
  methods: ['GET'], authLevel: 'anonymous', route: 'integrations/drive/{realmId}/files',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const acc = await driveClientAccess(p, realmId); if (acc.err) return acc.err;
    try {
      const dt = await driveDocAndToken(realmId); if (dt.err) return dt.err;
      const folderId = new URL(request.url).searchParams.get('folderId') || '';
      let items = [];
      const root = dt.doc.root || null;
      if (dt.doc.provider === 'google') {
        const start = folderId || (root && root.folderId) || 'root';
        const q = encodeURIComponent("'" + start + "' in parents and trashed=false");
        const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true', { headers: { Authorization: 'Bearer ' + dt.at } });
        if (!r.ok) throw new Error('Google Drive ' + r.status);
        const j = await r.json();
        items = (j.files || []).map(f => ({ id: f.id, name: f.name, folder: f.mimeType === 'application/vnd.google-apps.folder', size: f.size ? Number(f.size) : null, modified: f.modifiedTime || null, webUrl: f.webViewLink || null }));
      } else {
        let path;
        if (root && root.driveId) { path = '/drives/' + root.driveId + '/items/' + encodeURIComponent(folderId || root.itemId) + '/children'; }
        else { path = folderId ? ('/me/drive/items/' + encodeURIComponent(folderId) + '/children') : '/me/drive/root/children'; }
        const r = await fetch('https://graph.microsoft.com/v1.0' + path + '?$top=300&$select=id,name,folder,size,lastModifiedDateTime,webUrl', { headers: { Authorization: 'Bearer ' + dt.at } });
        if (!r.ok) {
          const detail = (await r.text().catch(() => '')).slice(0, 160);
          // No landing folder set + the account has no personal OneDrive → tell the UI to ask for the shared-folder link.
          if (!root && (r.status === 403 || r.status === 404)) return { jsonBody: { ok: false, needsRoot: true, provider: 'onedrive', account: dt.doc.account, error: 'This account has no personal OneDrive. Paste the link to the folder the client shared with ' + (dt.doc.account || 'it') + '.' } };
          throw new Error('OneDrive ' + r.status + (detail ? (': ' + detail) : ''));
        }
        const j = await r.json();
        items = (j.value || []).map(f => ({ id: f.id, name: f.name, folder: !!f.folder, size: f.size || null, modified: f.lastModifiedDateTime || null, webUrl: f.webUrl || null }));
      }
      items.sort((a, b) => ((b.folder ? 1 : 0) - (a.folder ? 1 : 0)) || String(a.name).localeCompare(b.name));
      return { jsonBody: { ok: true, provider: dt.doc.provider, account: dt.doc.account, folderId, items } };
    } catch (e) { context.error('drive-files', e); return { status: 502, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

// Download a file (proxied with the firm's token; client passes ?name= for the filename).
app.http('drive-download', {
  methods: ['GET'], authLevel: 'anonymous', route: 'integrations/drive/{realmId}/download/{fileId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId, fileId = request.params.fileId;
    const acc = await driveClientAccess(p, realmId); if (acc.err) return acc.err;
    try {
      const dt = await driveDocAndToken(realmId); if (dt.err) return dt.err;
      const odRoot = dt.doc.root && dt.doc.root.driveId;
      const mediaUrl = dt.doc.provider === 'google'
        ? ('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true')
        : ('https://graph.microsoft.com/v1.0' + (odRoot ? ('/drives/' + dt.doc.root.driveId) : '/me/drive') + '/items/' + encodeURIComponent(fileId) + '/content');
      const r = await fetch(mediaUrl, { headers: { Authorization: 'Bearer ' + dt.at } });
      if (!r.ok) return { status: 502, jsonBody: { ok: false, error: 'download failed (' + r.status + ')' } };
      const buf = Buffer.from(await r.arrayBuffer());
      const uq = new URL(request.url).searchParams;
      const name = (uq.get('name') || 'download').replace(/[^a-zA-Z0-9._ -]+/g, '_').slice(0, 120);
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const wantInline = uq.get('inline') === '1' && inlineOk(ct);
      return { status: 200, headers: { 'Content-Type': ct, 'Content-Disposition': (wantInline ? 'inline' : 'attachment') + '; filename="' + name + '"', 'X-Content-Type-Options': 'nosniff' }, body: buf };
    } catch (e) { context.error('drive-download', e); return { status: 502, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

// Upload a file into the client's drive (root or a folder). Read-write.
app.http('drive-upload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'integrations/drive/{realmId}/upload',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const acc = await driveClientAccess(p, realmId); if (acc.err) return acc.err;
    try {
      const dt = await driveDocAndToken(realmId); if (dt.err) return dt.err;
      const form = await request.formData();
      const file = form.get('file'); const folderId = String(form.get('folderId') || '');
      if (!file || typeof file.arrayBuffer !== 'function') return badRequest('file required');
      if (file.size > 4 * 1024 * 1024) return badRequest('file too large (max 4 MB for now)');
      const buf = Buffer.from(await file.arrayBuffer());
      const name = String(file.name || 'upload'); const ct = file.type || 'application/octet-stream';
      const root = dt.doc.root || null;
      if (dt.doc.provider === 'google') {
        const boundary = 'bcc' + Date.now().toString(36);
        const meta = { name }; const parent = folderId || (root && root.folderId); if (parent) meta.parents = [parent];
        const body = Buffer.concat([
          Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n'),
          Buffer.from('--' + boundary + '\r\nContent-Type: ' + ct + '\r\n\r\n'),
          buf,
          Buffer.from('\r\n--' + boundary + '--')
        ]);
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method: 'POST', headers: { Authorization: 'Bearer ' + dt.at, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
        if (!r.ok) throw new Error('Google upload ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
      } else {
        const safe = name.replace(/[#%?:*<>|"\\]+/g, '_');
        let path;
        if (root && root.driveId) { path = '/drives/' + root.driveId + '/items/' + encodeURIComponent(folderId || root.itemId) + ':/' + encodeURIComponent(safe) + ':/content'; }
        else { path = folderId ? ('/me/drive/items/' + encodeURIComponent(folderId) + ':/' + encodeURIComponent(safe) + ':/content') : ('/me/drive/root:/' + encodeURIComponent(safe) + ':/content'); }
        const r = await fetch('https://graph.microsoft.com/v1.0' + path, { method: 'PUT', headers: { Authorization: 'Bearer ' + dt.at, 'Content-Type': ct }, body: buf });
        if (!r.ok) throw new Error('OneDrive upload ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
      }
      return { jsonBody: { ok: true } };
    } catch (e) { context.error('drive-upload', e); return { status: 502, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

/**
 * GET /api/audit/client/{realmId}?days=7
 * Recent change activity for one client (audit rows whose meta.realmId matches),
 * gated by client access. Powers the per-client Activity section.
 */
app.http('audit-client', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'audit/client/{realmId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    try {
      const c = container();
      // Access gate: admins see all; others only enabled companies assigned to
      // them (or open to all) — mirrors the company-list scoping.
      const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      // Fail CLOSED for non-admins: require a company doc they can actually see
      // (audit rows exist independently of the company doc, so a missing doc must
      // not fall through to returning activity).
      if (!(await isAppAdmin(p))) {
        const who = String(p.userDetails || p.userId || '').toLowerCase();
        const allow = ((comp && comp.allowedUserUpns) || []).map(u => String(u).toLowerCase());
        if (!comp || comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { status: 403, jsonBody: { ok: false, error: 'no access to this client' } };
      }
      const u = new URL(request.url);
      let days = parseInt(u.searchParams.get('days') || '7', 10) || 7;
      if (days < 1) days = 1; if (days > 90) days = 90;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const { resources } = await c.items.query({
        query: 'SELECT TOP 300 c.ts, c.action, c.user, c.meta FROM c WHERE c.tenantId=@t AND c.docType="audit" AND c.ts>=@s AND c.meta.realmId=@r ORDER BY c.ts DESC',
        parameters: [{ name: '@t', value: BCC_TENANT_ID }, { name: '@s', value: since }, { name: '@r', value: realmId }]
      }).fetchAll();
      return { jsonBody: { ok: true, realmId, days, rows: resources } };
    } catch (e) { context.error('audit-client', e); return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
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
    // Read both, and prefer whichever actually HAS keys — the OAuth callback can
    // leave an empty top-level `fields: {}` that would otherwise shadow the real
    // credentials saved under .data.fields (an empty object is truthy).
    const top = resource && resource.fields;
    const nested = resource && resource.data && resource.data.fields;
    const fields = (top && Object.keys(top).length ? top : null) || nested || top || {};
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
    if (!(await isAppAdmin(p))) return forbidden('admin only');

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

        case 'google-drive':
          // Per-client OAuth (no firm-level token to exchange) — just confirm the
          // app creds are present and Google's OAuth endpoint is reachable.
          if (!fields.clientId || !fields.clientSecret) {
            result = { ok: false, error: 'OAuth Client ID and Client Secret required' };
          } else {
            const r = await fetch('https://accounts.google.com/.well-known/openid-configuration').catch(() => null);
            result = r && r.ok
              ? { ok: true, note: 'Credentials saved. Open a client’s Files tab and click "Connect Google Drive" to link that client.' }
              : { ok: false, error: 'could not reach Google OAuth endpoint (' + (r && r.status) + ')' };
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
    if (!(await isAppAdmin(p))) return forbidden('admin only');

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

      // Authorization: financial data is scoped per-company exactly like the
      // company list (admins see all; others only companies that are enabled
      // and either open to everyone or explicitly shared with them). This makes
      // the firm-wide financials access-controlled at the DATA layer, not just
      // the UI — a non-manager can never pull another client's books.
      const admin = await isAppAdmin(p);
      const who = String(p.userDetails || p.userId || '').toLowerCase();
      const callerCanSee = (comp) => {
        if (admin) return true;
        if (!comp || comp.enabled === false) return false;
        const allow = (comp.allowedUserUpns || []).map(u => String(u).toLowerCase());
        return allow.length === 0 || allow.indexOf(who) >= 0;
      };

      // Which companies to sync — one (body.realmId) or every connected company.
      let companyDocs;
      if (body && body.realmId) {
        const d = await c.item('bcc-qbo-company-' + body.realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
        if (d && !callerCanSee(d)) return { status: 403, jsonBody: { ok: false, error: 'no access to this company' } };
        companyDocs = d ? [d] : [];
      } else {
        const { resources } = await c.items.query({
          query: 'SELECT * FROM c WHERE c.tenantId=@t AND c.docType="qbo-company"',
          parameters: [{ name: '@t', value: BCC_TENANT_ID }]
        }).fetchAll();
        companyDocs = resources.filter(callerCanSee);
      }
      if (!companyDocs.length) {
        return { status: 400, jsonBody: { ok: false, error: 'No QBO companies connected yet. Click "Connect a company" first.' } };
      }

      const basic = Buffer.from(fields.clientId + ':' + fields.clientSecret).toString('base64');
      const now = new Date();
      const out = [];

      for (const comp of companyDocs) {
        // comp.environment is authoritative (stamped at connect time). The shared
        // connector field must NOT override a company upward to production —
        // otherwise flipping the connector to production re-points existing
        // sandbox companies at live books with a sandbox token.
        const env = comp.environment === 'production' ? 'production' : 'sandbox';
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
        if (tok.refresh_token && tok.refresh_token !== comp.refreshToken) {
          // Persist the rotated token NOW — before the 12 report calls below — so a
          // later throw can't lose it (Intuit has already invalidated the old one).
          comp.refreshToken = tok.refresh_token;
          comp.updatedAt = new Date().toISOString();
          try { await c.items.upsert(comp); }
          catch (e) { console.error('qbo-sync refresh-token persist FAILED for realm ' + comp.realmId + ':', e && e.message || e); }
        }

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
    // Signed state binds the saved token to the user who started the flow.
    const state = signOAuthState({ upn: p.userDetails || p.userId, t: Date.now() });
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
    const p = principal(request);
    if (err) return { status: 302, headers: { Location: '/admin.html?msgraph=' + encodeURIComponent(err) } };
    if (!code || !state) return { status: 400, jsonBody: { error: 'missing code or state' } };
    try {
      // Require a valid HMAC-signed state; bind the saved token to the UPN carried
      // in that tamper-proof state (an attacker can no longer choose the UPN). The
      // principal cookie is enforced only when present on the redirect.
      const st = verifyOAuthState(state);
      if (!st || !st.upn) {
        return { status: 302, headers: { Location: '/admin.html?msgraph=error&detail=' + encodeURIComponent('invalid or expired sign-in — start the connect again') } };
      }
      if (p && (!domainAllowed(p) || String(st.upn).toLowerCase() !== String(p.userDetails || p.userId || '').toLowerCase())) {
        return { status: 302, headers: { Location: '/admin.html?msgraph=error&detail=' + encodeURIComponent('sign-in mismatch — start the connect again') } };
      }
      const upn = st.upn;
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

      let upn;
      if (body.realmId) {
        const rc = await resolveClientMailbox(p, String(body.realmId));
        if (rc.err) return rc.err;
        if (!rc.cfg || !rc.cfg.mailbox || rc.cfg.enabled === false) return badRequest('no client mailbox configured for this client');
        upn = encodeURIComponent(rc.cfg.mailbox);
      } else {
        upn = encodeURIComponent(p.userDetails || p.userId);
      }
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
/* ===== Per-client mailbox (shared mailbox routing) =====
 * A client can have a dedicated shared mailbox (e.g. mikesrepair@bluecollarcoach.us).
 * The shared mailbox itself is created once by an M365 admin (Graph can't create
 * shared mailboxes); here we just store the address per client and route the
 * client's send/inbox through it. Config doc: bcc-client-mailbox-<realmId>.
 */
async function resolveClientMailbox(p, realmId) {
  const c = container();
  const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  if (!comp) return { err: { status: 404, jsonBody: { ok: false, error: 'company not connected' } } };
  if (!(await isAppAdmin(p))) {
    const who = String(p.userDetails || p.userId || '').toLowerCase();
    const allow = (comp.allowedUserUpns || []).map(u => u.toLowerCase());
    if (comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { err: { status: 403, jsonBody: { ok: false, error: 'no access to this client' } } };
  }
  const cfg = await c.item('bcc-client-mailbox-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  return { comp, cfg };
}

app.http('msgraph-client-mailbox', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/client-mailbox/{realmId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    try {
      const rc = await resolveClientMailbox(p, realmId);
      if (rc.err) return rc.err;
      if (request.method === 'GET') {
        return { jsonBody: { ok: true, mailbox: (rc.cfg && rc.cfg.mailbox) || '', enabled: rc.cfg ? rc.cfg.enabled !== false : false } };
      }
      if (!(await isAppAdmin(p))) return { status: 403, jsonBody: { ok: false, error: 'admin only' } };
      const b = await request.json().catch(() => ({}));
      const mailbox = String(b.mailbox || '').trim().toLowerCase();
      const enabled = b.enabled !== false;
      if (mailbox) {
        const dom = mailbox.split('@')[1] || '';
        if (ALLOWED_DOMAINS.indexOf(dom) < 0) return badRequest('mailbox must be on an allowed domain: ' + ALLOWED_DOMAINS.join(', '));
      }
      const c = container();
      await c.items.upsert({ id: 'bcc-client-mailbox-' + realmId, tenantId: BCC_TENANT_ID, docType: 'client-mailbox', realmId: realmId, mailbox: mailbox, enabled: enabled, updatedAt: new Date().toISOString(), updatedBy: String(p.userDetails || p.userId || '').toLowerCase() });
      return { jsonBody: { ok: true, mailbox: mailbox, enabled: enabled } };
    } catch (e) { context.error('client-mailbox', e); return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

/**
 * Reads a mailbox (app-only Mail.Read) and returns recent messages, optionally
 * filtered by $search. With ?realmId it reads that client's dedicated shared
 * mailbox; otherwise it reads the signed-in user's mailbox. Read-only.
 */
app.http('msgraph-messages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/msgraph/messages',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    try {
      const access = await getGraphToken();
      const u = new URL(request.url);
      const realmId = u.searchParams.get('realmId');
      let upn;
      if (realmId) {
        const rc = await resolveClientMailbox(p, realmId);
        if (rc.err) return rc.err;
        if (!rc.cfg || !rc.cfg.mailbox || rc.cfg.enabled === false) return { jsonBody: { ok: true, messages: [], note: 'no client mailbox configured' } };
        upn = encodeURIComponent(rc.cfg.mailbox);
      } else {
        upn = encodeURIComponent(p.userDetails || p.userId);
      }
      const q = (u.searchParams.get('q') || '').trim();
      const top = Math.min(parseInt(u.searchParams.get('top') || '25', 10) || 25, 50);
      const select = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink,hasAttachments';
      let gurl;
      if (q) {
        // $search cannot be combined with $orderby; it ranks by relevance/recency.
        gurl = 'https://graph.microsoft.com/v1.0/users/' + upn + '/messages?$search=' + encodeURIComponent('"' + q + '"') + '&$top=' + top + '&$select=' + select;
      } else {
        gurl = 'https://graph.microsoft.com/v1.0/users/' + upn + '/messages?$top=' + top + '&$orderby=receivedDateTime%20desc&$select=' + select;
      }
      const r = await fetch(gurl, { headers: { Authorization: 'Bearer ' + access } });
      if (!r.ok) { const detail = (await r.text()).slice(0, 300); return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')', detail } }; }
      const data = await r.json();
      const messages = (Array.isArray(data.value) ? data.value : []).map(m => ({
        id: m.id,
        subject: m.subject || '(no subject)',
        from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
        fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
        to: (m.toRecipients || []).map(x => x.emailAddress && x.emailAddress.address).filter(Boolean),
        received: m.receivedDateTime || '',
        preview: m.bodyPreview || '',
        isRead: !!m.isRead,
        webLink: m.webLink || '',
        hasAttachments: !!m.hasAttachments
      }));
      return { jsonBody: { ok: true, messages: messages } };
    } catch (e) {
      return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } };
    }
  })
});

/**
 * GET /api/integrations/msgraph/message/{id}?realmId=
 * Full single message (HTML body + headers + attachment list) so a bookkeeper can
 * read it entirely in-app. Access-gated + routed to the client mailbox.
 */
app.http('msgraph-message-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'integrations/msgraph/message/{id}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    try {
      const u = new URL(request.url); const realmId = u.searchParams.get('realmId');
      let upn;
      if (realmId) {
        const rc = await resolveClientMailbox(p, realmId); if (rc.err) return rc.err;
        if (!rc.cfg || !rc.cfg.mailbox || rc.cfg.enabled === false) return badRequest('no client mailbox configured');
        upn = encodeURIComponent(rc.cfg.mailbox);
      } else { upn = encodeURIComponent(p.userDetails || p.userId); }
      const access = await getGraphToken();
      const id = encodeURIComponent(request.params.id);
      const sel = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,webLink,hasAttachments,conversationId';
      const r = await fetch('https://graph.microsoft.com/v1.0/users/' + upn + '/messages/' + id + '?$select=' + sel, { headers: { Authorization: 'Bearer ' + access } });
      if (!r.ok) { const detail = (await r.text()).slice(0, 300); return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')', detail } }; }
      const m = await r.json();
      let attachments = [];
      if (m.hasAttachments) {
        try {
          const ar = await fetch('https://graph.microsoft.com/v1.0/users/' + upn + '/messages/' + id + '/attachments?$select=id,name,contentType,size', { headers: { Authorization: 'Bearer ' + access } });
          if (ar.ok) { const aj = await ar.json(); attachments = (aj.value || []).map(a => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size })); }
        } catch (_) {}
      }
      return { jsonBody: { ok: true, message: {
        id: m.id, subject: m.subject || '(no subject)',
        from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
        fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
        to: (m.toRecipients || []).map(x => x.emailAddress && x.emailAddress.address).filter(Boolean),
        cc: (m.ccRecipients || []).map(x => x.emailAddress && x.emailAddress.address).filter(Boolean),
        received: m.receivedDateTime || '', isRead: !!m.isRead, webLink: m.webLink || '',
        bodyType: (m.body && m.body.contentType) || 'text', bodyContent: (m.body && m.body.content) || '',
        hasAttachments: !!m.hasAttachments, attachments
      } } };
    } catch (e) { context.error('msgraph-message-get', e); return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

/**
 * POST /api/integrations/msgraph/reply  { realmId, messageId, body, replyAll }
 * Replies in-thread from the client mailbox (no Outlook needed). Access-gated.
 */
app.http('msgraph-reply', {
  methods: ['POST'], authLevel: 'anonymous', route: 'integrations/msgraph/reply',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    try {
      const b = await request.json().catch(() => ({}));
      const messageId = String(b.messageId || ''); if (!messageId) return badRequest('messageId required');
      let upn;
      if (b.realmId) {
        const rc = await resolveClientMailbox(p, String(b.realmId)); if (rc.err) return rc.err;
        if (!rc.cfg || !rc.cfg.mailbox || rc.cfg.enabled === false) return badRequest('no client mailbox configured');
        upn = encodeURIComponent(rc.cfg.mailbox);
      } else { upn = encodeURIComponent(p.userDetails || p.userId); }
      const access = await getGraphToken();
      const action = b.replyAll ? 'replyAll' : 'reply';
      const r = await fetch('https://graph.microsoft.com/v1.0/users/' + upn + '/messages/' + encodeURIComponent(messageId) + '/' + action, {
        method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: String(b.body || '') })
      });
      if (!r.ok && r.status !== 202) { const detail = (await r.text()).slice(0, 300); return { status: 502, jsonBody: { ok: false, error: 'Graph rejected (' + r.status + ')', detail } }; }
      return { jsonBody: { ok: true } };
    } catch (e) { context.error('msgraph-reply', e); return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

/**
 * Per-client email COLLABORATION metadata (who-read / who-replied / tags /
 * assignment / archive), keyed by Graph message id. Stored server-side as
 * bcc-emailmeta-<realm> (a map). Access-gated; optimistic-concurrency on write.
 *   GET  /api/bookkeeping/email-meta/{realmId}            -> { ok, msgs }
 *   POST /api/bookkeeping/email-meta/{realmId}  { messageId, op, value }
 */
app.http('email-meta', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'bookkeeping/email-meta/{realmId}',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request); if (!p) return unauthorized(); if (!domainAllowed(p)) return domainBlocked();
    const realmId = request.params.realmId;
    const rc = await resolveClientMailbox(p, realmId); if (rc.err) return rc.err;
    const c = container(); const id = 'bcc-emailmeta-' + realmId;
    const who = String(p.userDetails || p.userId || '').toLowerCase();
    if (request.method === 'GET') {
      const doc = await c.item(id, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      return { jsonBody: { ok: true, msgs: (doc && doc.msgs) || {} } };
    }
    const b = await request.json().catch(() => ({}));
    const messageId = String(b.messageId || ''); const op = String(b.op || '');
    if (!messageId || !op) return badRequest('messageId and op required');
    const now = new Date().toISOString();
    // read-modify-write with one optimistic retry on a concurrent change.
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await c.item(id, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
      const doc = existing || { id, tenantId: BCC_TENANT_ID, docType: 'email-meta', realmId, msgs: {} };
      if (!doc.msgs) doc.msgs = {};
      const m = doc.msgs[messageId] || (doc.msgs[messageId] = { tags: [], assignedTo: '', archived: false, readBy: {}, repliedBy: [] });
      if (op === 'read') { m.readBy = m.readBy || {}; if (!m.readBy[who]) m.readBy[who] = now; }
      else if (op === 'unread') { if (m.readBy) delete m.readBy[who]; }
      else if (op === 'replied') { m.repliedBy = m.repliedBy || []; m.repliedBy.push({ upn: who, at: now }); }
      else if (op === 'tagAdd') { const t = String(b.value || '').trim(); if (t) { m.tags = m.tags || []; if (m.tags.map(x => x.toLowerCase()).indexOf(t.toLowerCase()) < 0) m.tags.push(t); } }
      else if (op === 'tagRemove') { const t = String(b.value || '').toLowerCase(); m.tags = (m.tags || []).filter(x => x.toLowerCase() !== t); }
      else if (op === 'assign') { m.assignedTo = String(b.value || '').toLowerCase(); }
      else if (op === 'archive') { m.archived = !!b.value; }
      else return badRequest('unknown op');
      doc.updatedAt = now;
      try {
        if (existing && existing._etag) await c.item(id, BCC_TENANT_ID).replace(doc, { accessCondition: { type: 'IfMatch', condition: existing._etag } });
        else await c.items.create(doc);
        return { jsonBody: { ok: true, msg: doc.msgs[messageId] } };
      } catch (e) { if ((e.code === 412 || e.code === 409) && attempt === 0) continue; throw e; }
    }
    return { status: 409, jsonBody: { ok: false, error: 'conflict, retry' } };
  })
});

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
      const state = signOAuthState({ upn: p.userDetails || p.userId, env, t: Date.now() });
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
    const p = principal(request);
    // Breadcrumb: prove the callback was reached + what Intuit sent back.
    try {
      await container().items.upsert({ id: 'bcc-qbo-debug-callback', tenantId: BCC_TENANT_ID, docType: 'qbo-debug',
        at: new Date().toISOString(), hasCode: !!code, realmId: realmId || null, error: err || null,
        query: (url.search || '').slice(0, 300), xMsOriginalUrl: request.headers.get('x-ms-original-url') || null });
    } catch (_) {}
    if (err) return { status: 302, headers: { Location: '/bookkeeping.html?qbo=' + encodeURIComponent(err) } };
    if (!code || !realmId) return { status: 400, jsonBody: { error: 'missing code or realmId' } };
    // A valid HMAC-signed state is REQUIRED (can't be forged/replayed; expires in
    // 15 min; carries the firm UPN that started the connect). The principal cookie
    // may or may not ride along on the Intuit redirect, so we enforce it only when
    // present rather than hard-failing a known-good flow.
    const st = verifyOAuthState(state);
    if (!st || !st.upn) return { status: 302, headers: { Location: '/bookkeeping.html?qbo=error&detail=' + encodeURIComponent('invalid or expired sign-in — start the connect again') } };
    if (p && (!domainAllowed(p) || String(st.upn).toLowerCase() !== String(p.userDetails || p.userId || '').toLowerCase())) {
      return { status: 302, headers: { Location: '/bookkeeping.html?qbo=error&detail=' + encodeURIComponent('sign-in mismatch — start the connect again') } };
    }
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

      // Use the environment chosen at connect time (carried in the signed state),
      // so this company is permanently stamped with that env regardless of later
      // changes to the shared connector field.
      const env = st.env === 'production' ? 'production' : 'sandbox';
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

      // Mark the shared integration row connected — WITHOUT clobbering the saved
      // credentials. If creds live under .data.fields (the UI-save shape), do not
      // create an empty top-level `fields: {}` that would shadow them.
      const id = 'bcc-integration-qbo';
      const doc = await c.item(id, BCC_TENANT_ID).read().then(rr => rr.resource).catch(() => null);
      const rec = doc || { id, tenantId: BCC_TENANT_ID, docType: 'integration', channel: 'qbo', data: { fields: {} } };
      if (rec.fields && Object.keys(rec.fields).length === 0) delete rec.fields; // drop a stale empty top-level fields
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
  if (tok.refresh_token && tok.refresh_token !== comp.refreshToken) {
    comp.refreshToken = tok.refresh_token;
    // Persist the rotated token; if this write fails, the OLD token is already
    // invalidated by Intuit, so surface it loudly rather than silently bricking.
    try { await container().items.upsert(comp); }
    catch (e) { console.error('QBO refresh-token persist FAILED for realm ' + comp.realmId + ' — connection may need reauth:', e && e.message || e); }
  }
  // comp.environment is authoritative — never let the shared connector field
  // override a sandbox company up to production (or vice-versa).
  const env = comp.environment === 'production' ? 'production' : 'sandbox';
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
        case 'invoices': { data = { kind: 'list', editable: 'invoice', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef FROM Invoice WHERE Balance > '0'")).map(x => ({ id: x.Id, doc: x.DocNumber, name: x.CustomerRef && x.CustomerRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance })) }; break; }
        case 'bills': { data = { kind: 'list', editable: 'bill', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, VendorRef FROM Bill WHERE Balance > '0'")).map(x => ({ id: x.Id, doc: x.DocNumber, name: x.VendorRef && x.VendorRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance })) }; break; }
        case 'transactions': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = flattenQboReport(await apiGet('/reports/TransactionList?start_date=' + from + '&end_date=' + to)); data.range = { from, to }; data.kind = 'report'; break;
        }
        case 'payments': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = { kind: 'list', items: (await queryAll("SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef FROM Payment WHERE TxnDate >= '" + from + "' AND TxnDate <= '" + to + "' ORDERBY TxnDate DESC")).map(x => ({ date: x.TxnDate, ref: x.PaymentRefNum, name: x.CustomerRef && x.CustomerRef.name, total: x.TotalAmt })) }; break;
        }
        case 'expenses': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = { kind: 'list', items: (await queryAll("SELECT Id, TxnDate, TotalAmt, DocNumber, PaymentType, EntityRef FROM Purchase WHERE TxnDate >= '" + from + "' AND TxnDate <= '" + to + "' ORDERBY TxnDate DESC")).map(x => ({ date: x.TxnDate, doc: x.DocNumber, name: x.EntityRef && x.EntityRef.name, type: x.PaymentType, total: x.TotalAmt })) }; break;
        }
        case 'all-invoices': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = { kind: 'list', editable: 'invoice', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef FROM Invoice WHERE TxnDate >= '" + from + "' AND TxnDate <= '" + to + "' ORDERBY TxnDate DESC")).map(x => ({ id: x.Id, doc: x.DocNumber, name: x.CustomerRef && x.CustomerRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance, status: (Number(x.Balance) > 0 ? 'open' : 'paid') })) }; break;
        }
        case 'all-bills': {
          const from = url.searchParams.get('from') || yStart, to = url.searchParams.get('to') || today;
          data = { kind: 'list', editable: 'bill', items: (await queryAll("SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, VendorRef FROM Bill WHERE TxnDate >= '" + from + "' AND TxnDate <= '" + to + "' ORDERBY TxnDate DESC")).map(x => ({ id: x.Id, doc: x.DocNumber, name: x.VendorRef && x.VendorRef.name, date: x.TxnDate, due: x.DueDate, total: x.TotalAmt, balance: x.Balance, status: (Number(x.Balance) > 0 ? 'open' : 'paid') })) }; break;
        }
        default: return { status: 400, jsonBody: { error: 'unknown report type "' + type + '"' } };
      }
      return { jsonBody: { type, realmId, companyName: comp.companyName, data } };
    } catch (e) {
      context.error('qbo-report error', e);
      return { status: 502, jsonBody: { error: String(e.message || e) } };
    }
  })
});

/* ===== QBO write helpers shared by refs / entity / write endpoints ===== */
async function qboResolveAccess(request, realmId) {
  const p = principal(request);
  if (!p) return { err: unauthorized() };
  if (!domainAllowed(p)) return { err: domainBlocked() };
  const c = container();
  const comp = await c.item('bcc-qbo-company-' + realmId, BCC_TENANT_ID).read().then(r => r.resource).catch(() => null);
  if (!comp) return { err: { status: 404, jsonBody: { error: 'company not connected' } } };
  if (!(await isAppAdmin(p))) {
    const who = String(p.userDetails || p.userId || '').toLowerCase();
    const allow = (comp.allowedUserUpns || []).map(u => u.toLowerCase());
    if (comp.enabled === false || (allow.length && allow.indexOf(who) < 0)) return { err: { status: 403, jsonBody: { error: 'no access to this company' } } };
  }
  const fields = await getIntegrationFields('qbo');
  const { accessToken, base } = await qboAccessForCompany(comp, fields);
  const apiGet = async (path) => {
    const u = base + '/v3/company/' + encodeURIComponent(realmId) + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'minorversion=70';
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
    if (!r.ok) throw new Error('QBO ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 250));
    return r.json();
  };
  const apiPost = async (path, bodyObj) => {
    const u = base + '/v3/company/' + encodeURIComponent(realmId) + path + '?minorversion=70';
    const r = await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
    if (!r.ok) throw new Error('QBO ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 300));
    return r.json();
  };
  const queryAll = async (sql) => { const j = await apiGet('/query?query=' + encodeURIComponent(sql + ' MAXRESULTS 1000')); const qr = j.QueryResponse || {}; const k = Object.keys(qr).find(x => Array.isArray(qr[x])); return k ? qr[k] : []; };
  const apiUpload = async (path, formData) => {
    // Multipart upload (e.g. QBO /upload). Let fetch set the multipart boundary;
    // do NOT set Content-Type manually.
    const u = base + '/v3/company/' + encodeURIComponent(realmId) + path + '?minorversion=70';
    const r = await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }, body: formData });
    if (!r.ok) throw new Error('QBO ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 300));
    return r.json();
  };
  return { p, comp, apiGet, apiPost, apiUpload, queryAll };
}

/** GET refs — dropdown data for the transaction forms (customers/vendors/items/accounts). */
app.http('qbo-refs', {
  methods: ['GET'], authLevel: 'anonymous', route: 'integrations/qbo/companies/{realmId}/refs',
  handler: withAccessLog(async (request, context) => {
    try {
      const ctx = await qboResolveAccess(request, request.params.realmId);
      if (ctx.err) return ctx.err;
      const customers = (await ctx.queryAll('SELECT Id, DisplayName FROM Customer WHERE Active = true')).map(x => ({ id: x.Id, name: x.DisplayName }));
      const vendors   = (await ctx.queryAll('SELECT Id, DisplayName FROM Vendor WHERE Active = true')).map(x => ({ id: x.Id, name: x.DisplayName }));
      const items     = (await ctx.queryAll('SELECT Id, Name, UnitPrice FROM Item WHERE Active = true')).map(x => ({ id: x.Id, name: x.Name, price: x.UnitPrice }));
      const accounts  = (await ctx.queryAll('SELECT Id, Name, AccountType, Classification FROM Account WHERE Active = true')).map(x => ({ id: x.Id, name: x.Name, type: x.AccountType, classification: x.Classification }));
      return { jsonBody: { ok: true, customers, vendors, items, accounts } };
    } catch (e) { context.error('qbo-refs', e); return { status: 502, jsonBody: { ok: false, error: String(e.message || e) } }; }
  })
});

/** GET entity — fetch one invoice/bill for edit prefill (includes SyncToken). */
app.http('qbo-entity', {
  methods: ['GET'], authLevel: 'anonymous', route: 'integrations/qbo/companies/{realmId}/entity',
  handler: withAccessLog(async (request, context) => {
    try {
      const ctx = await qboResolveAccess(request, request.params.realmId);
      if (ctx.err) return ctx.err;
      const u = new URL(request.url);
      const type = (u.searchParams.get('type') || '').toLowerCase();
      const id = u.searchParams.get('id');
      const cap = { invoice: 'Invoice', bill: 'Bill', payment: 'Payment' }[type];
      if (!cap || !id) return badRequest('type (invoice|bill|payment) and id required');
      const j = await ctx.apiGet('/' + type + '/' + encodeURIComponent(id));
      return { jsonBody: { ok: true, entity: j[cap] || null } };
    } catch (e) { context.error('qbo-entity', e); return { status: 502, jsonBody: { ok: false, error: String(e.message || e) } }; }
  })
});

/** POST write — create or update an invoice / bill / payment in the client's QBO. */
app.http('qbo-write', {
  methods: ['POST'], authLevel: 'anonymous', route: 'integrations/qbo/companies/{realmId}/write',
  handler: withAccessLog(async (request, context) => {
    try {
      const ctx = await qboResolveAccess(request, request.params.realmId);
      if (ctx.err) return ctx.err;
      const b = await request.json().catch(() => ({}));
      const entity = String(b.entity || '').toLowerCase();
      const f = b.fields || {};
      const cap = { invoice: 'Invoice', bill: 'Bill', payment: 'Payment', customer: 'Customer', vendor: 'Vendor', item: 'Item', account: 'Account' }[entity];
      if (!cap) return badRequest('unsupported entity: ' + entity);
      let payload;
      if (entity === 'invoice') {
        const lines = (f.lines || []).filter(l => l && (l.amount || l.itemId)).map(l => ({
          DetailType: 'SalesItemLineDetail', Amount: Number(l.amount) || 0, Description: l.desc || undefined,
          SalesItemLineDetail: Object.assign({ ItemRef: { value: String(l.itemId) } }, l.qty ? { Qty: Number(l.qty) } : {}, l.unitPrice ? { UnitPrice: Number(l.unitPrice) } : {})
        }));
        if (!f.customerId || !lines.length) return badRequest('customer and at least one line required');
        payload = { CustomerRef: { value: String(f.customerId) }, Line: lines };
        if (f.txnDate) payload.TxnDate = f.txnDate; if (f.dueDate) payload.DueDate = f.dueDate;
      } else if (entity === 'bill') {
        const lines = (f.lines || []).filter(l => l && (l.amount || l.accountId)).map(l => ({
          DetailType: 'AccountBasedExpenseLineDetail', Amount: Number(l.amount) || 0, Description: l.desc || undefined,
          AccountBasedExpenseLineDetail: { AccountRef: { value: String(l.accountId) } }
        }));
        if (!f.vendorId || !lines.length) return badRequest('vendor and at least one line required');
        payload = { VendorRef: { value: String(f.vendorId) }, Line: lines };
        if (f.txnDate) payload.TxnDate = f.txnDate; if (f.dueDate) payload.DueDate = f.dueDate;
      } else if (entity === 'payment') {
        if (!f.customerId || !f.totalAmt) return badRequest('customer and amount required');
        payload = { CustomerRef: { value: String(f.customerId) }, TotalAmt: Number(f.totalAmt) || 0 };
        if (f.txnDate) payload.TxnDate = f.txnDate;
        if (f.depositAccountId) payload.DepositToAccountRef = { value: String(f.depositAccountId) };
        if (f.invoiceId) payload.Line = [{ Amount: Number(f.totalAmt) || 0, LinkedTxn: [{ TxnId: String(f.invoiceId), TxnType: 'Invoice' }] }];
      } else if (entity === 'customer' || entity === 'vendor') {
        if (!f.displayName) return badRequest('name required');
        payload = { DisplayName: String(f.displayName) };
        if (f.companyName) payload.CompanyName = String(f.companyName);
        if (f.email) payload.PrimaryEmailAddr = { Address: String(f.email) };
        if (f.phone) payload.PrimaryPhone = { FreeFormNumber: String(f.phone) };
      } else if (entity === 'account') {
        if (!f.name || !f.accountType) return badRequest('name and accountType required');
        payload = { Name: String(f.name), AccountType: String(f.accountType) };
        if (f.acctSubType) payload.AccountSubType = String(f.acctSubType);
      } else if (entity === 'item') {
        if (!f.name || !f.itemType) return badRequest('name and itemType required');
        payload = { Name: String(f.name), Type: String(f.itemType) };
        if (f.incomeAccountId) payload.IncomeAccountRef = { value: String(f.incomeAccountId) };
        if (f.expenseAccountId) payload.ExpenseAccountRef = { value: String(f.expenseAccountId) };
        if (f.unitPrice) payload.UnitPrice = Number(f.unitPrice);
      }
      if (b.op === 'update') {
        if (!b.id || !b.syncToken) return badRequest('id and syncToken required for update');
        // NOTE: with sparse:true QBO leaves omitted fields untouched, BUT if Line
        // is present it FULLY REPLACES the existing lines. The edit UI prefills the
        // complete current line set (via qbo-entity) so the resubmit carries them
        // all; the >=1-line guard above prevents an accidental blank, and the
        // client confirm dialog shows the resulting total before posting.
        payload.Id = String(b.id); payload.SyncToken = String(b.syncToken); payload.sparse = true;
      }
      const res = await ctx.apiPost('/' + entity, payload);
      const created = res[cap] || {};
      return { jsonBody: { ok: true, id: created.Id, docNumber: created.DocNumber, syncToken: created.SyncToken, total: created.TotalAmt } };
    } catch (e) { context.error('qbo-write', e); return { status: 502, jsonBody: { ok: false, error: String(e.message || e) } }; }
  })
});

/**
 * POST /api/integrations/qbo/companies/{realmId}/attach  (multipart: file, entityType, entityId)
 * Uploads a file to QuickBooks and links it to the given transaction via the
 * Attachable upload API (/v3/company/{realm}/upload). Best-effort from the UI.
 */
app.http('qbo-attach', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/qbo/companies/{realmId}/attach',
  handler: withAccessLog(async (request, context) => {
    try {
      const ctx = await qboResolveAccess(request, request.params.realmId);
      if (ctx.err) return ctx.err;
      const form = await request.formData();
      const file = form.get('file');
      const entityType = String(form.get('entityType') || '');
      const entityId = String(form.get('entityId') || '');
      if (!file || typeof file.arrayBuffer !== 'function') return badRequest('file required');
      if (!entityType || !entityId) return badRequest('entityType and entityId required');
      if (file.size > 25 * 1024 * 1024) return badRequest('file too large (max 25 MB)');
      const buf = Buffer.from(await file.arrayBuffer());
      const filename = String(file.name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
      const contentType = file.type || 'application/octet-stream';
      const meta = { AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }], FileName: filename, ContentType: contentType };
      // QBO upload: two parts with matching index — JSON metadata + binary content.
      const fd = new FormData();
      fd.append('file_metadata_0', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json');
      fd.append('file_content_0', new Blob([buf], { type: contentType }), filename);
      const res = await ctx.apiUpload('/upload', fd);
      const item = (res && res.AttachableResponse && res.AttachableResponse[0]) || {};
      if (item.Fault) return { status: 502, jsonBody: { ok: false, error: 'QBO attach fault', detail: JSON.stringify(item.Fault).slice(0, 300) } };
      const att = item.Attachable || {};
      return { jsonBody: { ok: true, id: att.Id, fileName: att.FileName } };
    } catch (e) { context.error('qbo-attach', e); return { status: 502, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
  })
});

/**
 * POST /api/ai/extract-receipt  (multipart: file)
 * Sends a receipt/invoice image or PDF to Claude and returns structured fields
 * (vendor, date, subtotal, tax, total, line items) to auto-fill a transaction.
 * Requires ANTHROPIC_API_KEY app setting; returns needsKey:true if absent.
 */
app.http('ai-extract-receipt', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'ai/extract-receipt',
  handler: withAccessLog(async (request, context) => {
    const p = principal(request);
    if (!p) return unauthorized();
    if (!domainAllowed(p)) return domainBlocked();
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { jsonBody: { ok: false, needsKey: true, error: 'AI not configured — add ANTHROPIC_API_KEY in the app settings.' } };
    try {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') return badRequest('file required');
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return badRequest('file too large (max 12 MB)');
      const b64 = buf.toString('base64');
      const mt = (file.type || '').toLowerCase() || 'image/jpeg';
      const isPdf = /pdf/.test(mt);
      const srcBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: (/(png|jpe?g|webp|gif)/.test(mt) ? mt : 'image/jpeg'), data: b64 } };
      // Realm-aware matching: feed the client's vendors + expense accounts so the
      // model can pick the matching vendor Id and the best expense account Id.
      let matchHint = '';
      const realmId = (form.get('realmId') || '').toString();
      if (realmId) {
        try {
          const ctx = await qboResolveAccess(request, realmId);
          if (!ctx.err) {
            const vendors = await ctx.queryAll('SELECT Id, DisplayName FROM Vendor WHERE Active = true');
            const accts = await ctx.queryAll("SELECT Id, Name FROM Account WHERE Active = true AND AccountType IN ('Expense','Cost of Goods Sold','Other Expense')");
            const vtxt = vendors.slice(0, 300).map(v => v.Id + ': ' + v.DisplayName).join('\n');
            const atxt = accts.slice(0, 300).map(a => a.Id + ': ' + a.Name).join('\n');
            matchHint = '\n\nExisting QuickBooks vendors (id: name):\n' + vtxt + '\n\nExpense accounts (id: name):\n' + atxt +
              '\n\nIf the document vendor matches one of these vendors, set matchedVendorId to that exact id. Choose the single best-fitting expenseAccountId from the expense accounts above for categorizing this purchase.';
          }
        } catch (e) { /* matching is best-effort */ }
      }
      const tool = {
        name: 'record_document',
        description: 'Record the structured data extracted from a receipt or invoice.',
        input_schema: {
          type: 'object',
          properties: {
            docType: { type: 'string', enum: ['receipt', 'invoice', 'other'] },
            vendorName: { type: 'string', description: 'Merchant / vendor / supplier name' },
            date: { type: 'string', description: 'Transaction date as YYYY-MM-DD' },
            currency: { type: 'string' },
            subtotal: { type: 'number' },
            tax: { type: 'number' },
            total: { type: 'number' },
            lineItems: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, amount: { type: 'number' }, quantity: { type: 'number' } } } },
            suggestedCategory: { type: 'string', description: 'A likely expense category, e.g. Fuel, Office Supplies, Meals' },
            matchedVendorId: { type: 'string', description: 'QuickBooks vendor Id if the document vendor matches one in the provided list; omit if no match' },
            expenseAccountId: { type: 'string', description: 'Best-fit QuickBooks expense account Id from the provided list for categorizing this purchase; omit if unknown' }
          },
          required: ['docType', 'total']
        }
      };
      const model = process.env.AI_MODEL || 'claude-sonnet-4-6';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model, max_tokens: 1024, tools: [tool], tool_choice: { type: 'tool', name: 'record_document' },
          messages: [{ role: 'user', content: [srcBlock, { type: 'text', text: 'Extract the vendor, date (YYYY-MM-DD), subtotal, tax, total, currency, and individual line items from this document. Call record_document with the data.' + matchHint }] }]
        })
      });
      if (!r.ok) { const t = (await r.text().catch(() => '')).slice(0, 300); return { status: 502, jsonBody: { ok: false, error: 'AI error ' + r.status, detail: t } }; }
      const j = await r.json();
      const tu = (j.content || []).find(c => c.type === 'tool_use');
      if (!tu) return { jsonBody: { ok: false, error: 'No data extracted' } };
      return { jsonBody: { ok: true, data: tu.input } };
    } catch (e) { context.error('ai-extract', e); return { status: 500, jsonBody: { ok: false, error: String(e && e.message || e) } }; }
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
      // ?inline=1 → render in-app (image/pdf/text only); blob SAS is on a separate
      // *.blob.core.windows.net origin, so even an inline page can't touch our app.
      const wantInline = new URL(request.url).searchParams.get('inline') === '1' && inlineOk(meta.mimeType);
      const sas = generateBlobSASQueryParameters({
        containerName: cont.containerName,
        blobName: meta.storageKey,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(now.getTime() - 60 * 1000),
        expiresOn: expiry,
        contentDisposition: (wantInline ? 'inline' : 'attachment') + '; filename="' + filename + '"',
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

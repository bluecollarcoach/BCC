# BCC Internal — Build Sheet

Single source of truth for what's built, what's planned, and what's blocked.
Tick the boxes as you ship; add new items at the bottom of each module.

---

## Current state

| | |
|---|---|
| **Live URL** | <https://bccinternal-web-cmos6krt7roia.azurewebsites.net> |
| **Subscription** | Azure subscription 1 · Pay-As-You-Go · `da0f6d99-…` |
| **Tenant** | bluecollarcoach.us · `81acb8ef-…` |
| **Resource group** | `rg-bcc-internal` · West US 2 |
| **App Service** | B1 Linux · Node 20-lts |
| **Database** | Azure SQL Serverless GP_S_Gen5_2 · auto-pause |
| **Realtime** | SignalR Free_F1 |
| **Storage** | LRS + container `bcc-docs` |
| **Telemetry** | Application Insights |
| **Realistic cost** | ~$20–30/mo at current usage |
| **Local source** | `C:\Users\Apric\Downloads\BCC-Internal\` |
| **Source `BCC` (customer-facing twin)** | `C:\Users\Apric\Downloads\BCC\` |

---

## How to use this doc

**Status legend**

| | |
|---|---|
| ✅ | Shipped — live in production |
| 🚧 | In progress — partly built |
| 🟡 | Planned — defined and ready to start |
| ⛔ | Blocked — gated on an external approval / decision |
| 💤 | Deferred — punted to a later batch |
| ❓ | Needs clarification before starting |

**Effort legend** (rough writing time, excludes deploy + smoke)

| | |
|---|---|
| **XS** | < 1 hr |
| **S**  | 1–4 hr |
| **M**  | half day |
| **L**  | full day |
| **XL** | 2–4 days |
| **XXL** | 1–2 weeks |
| **∞**  | open-ended / multi-week / requires repeated provider gating |

**Workflow**

1. Pick an item with status 🟡 from one of the modules below
2. Run a deploy from `BCC-Internal/` (one redeploy can carry 5–10 small items if I batch them)
3. Run `scripts/smoke.sh` after deploy
4. Move the box from 🟡 to ✅ in this file and commit

---

## 1. Platform & Infrastructure

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Bicep template covering all 6 resources | `infra/azure/main.bicep` |
| ✅ | Tier picker: free / dev / prod | switches App Service + SignalR SKUs |
| ✅ | Deploy via `az deployment group create` | one-shot |
| ✅ | Deploy via Kudu `/api/zipdeploy?isAsync=true` | what I've been using; bypasses the 504 timeout on `az webapp deploy` |
| ✅ | App Insights env var injected | both server + browser slots |
| ✅ | SQL widening for OAuth tokens | `docs/sql-prod-fixes.sql` — ran once |
| ✅ | Contact address columns | `docs/sql-add-contact-address.sql` — ran once |
| ✅ | Org auto-bootstrap on first sign-in | `lib/auth.ts` jwt callback |
| 🟡 | GitHub Actions auto-deploy on push to main | **S** — workflow file is in `.github/workflows/deploy.yml`, needs OIDC creds wired |
| 🟡 | Custom domain `internal.bluecollarcoach.us` | **S** — CNAME + Managed Cert in App Service |
| 🟡 | Bake `AUTH_URL` into Bicep | **XS** — currently set manually post-deploy |
| 🟡 | Bake App Service outbound IPs into SQL firewall via Bicep | **XS** — currently 32 manual rules |
| 🟡 | Key Vault for secrets | **M** — replaces inline params with `@Microsoft.KeyVault(...)` references |
| 🟡 | Backup verification | **S** — Azure SQL auto-backups exist; verify restore works |
| 💤 | Request B1 quota increase for B2 headroom | **XS** — submit ticket; no business need yet |

---

## 2. Auth & RBAC

| Status | Item | Notes / file |
|---|---|---|
| ✅ | NextAuth v5 + Prisma adapter + JWT session | `lib/auth.ts` |
| ✅ | Edge-safe middleware config | `lib/auth.config.ts` (no Prisma in Edge) |
| ✅ | Microsoft Entra ID provider | client ID `a3ebdbef-…` |
| ✅ | Token refresh implementation | `integrations/microsoft-graph/graph.ts` |
| ✅ | Account-row token columns widened to NVARCHAR(MAX) | id_token + access_token + refresh_token + session_state |
| ✅ | Dev bypass disabled in production | `DEV_AUTH_BYPASS=false` on App Service |
| ✅ | RBAC matrix | OWNER / ADMIN / COACH / STAFF / CUSTOMER — `lib/rbac.ts` |
| ✅ | Auto-org bootstrap on first sign-in | First user → OWNER + default Org |
| ✅ | JWT enrichment runs only on sign-in (not per request) | Fixes per-page bounce issue |
| 🟡 | User invite flow (Admin → Users → Invite) | **M** — sends Entra B2B invitation OR creates pending user row |
| 🟡 | Multi-org switcher (UI) | **M** — schema supports, no UI yet |
| 🟡 | Force MFA on Entra side | **XS** (portal config, not code) |
| 🟡 | Sign-out from all sessions | **S** — Auth.js has `signOut` but JWT-mode doesn't centrally revoke |
| 💤 | API key auth for service-to-service | **L** — not needed yet |
| 💤 | SCIM provisioning | **XL** |

---

## 3. Brand & Design System

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Real PNG brand mark | `public/bcc-icon.png` + `bcc-logo-full.png` + `src/app/icon.png` (favicon) |
| ✅ | Tailwind theme tokens | `tailwind.config.ts` + `globals.css` |
| ✅ | Inter (body) + Cinzel (wordmark) via `next/font/google` | `app/layout.tsx` |
| ✅ | Dark-chrome + light-content layout pattern | sidebar/topbar dark, content white |
| ✅ | Logo component with `lockup` and `onDark` modes | `components/brand/logo.tsx` |
| ✅ | Portable stylesheet for `bluecollarcoach.us` | `styleguide/bcc-theme.css` + `demo.html` + `README.md` |
| 🟡 | Light/dark mode toggle for users | **S** — Tailwind supports it via the `dark:` variant, just needs a toggle |
| 🟡 | Color palette page in /admin/kb | **XS** — render the design tokens |
| 💤 | Logo on email templates (transactional) | **S** — when email is wired |

---

## 4. Dashboard

| Status | Item | Notes / file |
|---|---|---|
| ✅ | 6 KPI cards | `(app)/dashboard/page.tsx` |
| ✅ | Revenue chart (Recharts area) | `components/dashboard/revenue-chart.tsx` |
| ✅ | "What's next" attention queue | mocked links |
| ✅ | Pipeline health + crew utilization (mock data) | mocked tables |
| 🟡 | Wire crew utilization to real time entries | **S** |
| 🟡 | Wire pipeline health to real deals | **S** |
| 🟡 | "What's next" → real follow-up tasks | **M** |
| 🟡 | Per-role dashboards (OWNER vs COACH vs STAFF) | **M** |
| 💤 | Customizable layout (drag tiles) | **L** |

---

## 5. CRM

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Contact CRUD (list, new, detail, delete) | `(app)/crm/` |
| ✅ | Address fields (street/city/state/postalCode/country/region) | schema + UI |
| ✅ | Region + State + Stage filters | `/crm/page.tsx` |
| ✅ | Search (name/email/phone/city) | same |
| ✅ | CSV bulk upload with preview + dedup | `/crm/contacts/import` |
| ✅ | CSV header alias map (first/firstname/fname, zip/postalcode, etc.) | `parseContactsCsv` |
| ✅ | Audit log on create/update/delete/bulk-import | `audit` helper |
| ✅ | Deal pipeline kanban | `/crm/deals/page.tsx` |
| ✅ | Deal detail page + edit (`/crm/deals/[id]`) | with status change, stage move, contact/company links |
| ✅ | Deal create form (`/crm/deals/new`) | pipeline+stage+contact+company selectors |
| ✅ | Company CRUD (list, new, detail/edit, delete) | `/crm/companies/*` |
| ✅ | CSV export | `/api/crm/contacts/export` — respects current filters |
| 🟡 | Activity log per contact (calls/emails/meetings/notes/tasks) | **M** — schema exists, UI pending |
| 🟡 | Map view (group by region/state) | **L** — add Leaflet or Mapbox |
| 🟡 | Saved segments / smart lists | **M** |
| 🟡 | Email-on-create-or-update workflows | **M** — depends on email |
| 💤 | LinkedIn enrichment | **L** — needs LinkedIn API |
| 💤 | De-dupe wizard for existing data | **M** |

---

## 6. Calendar

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Week view with prev/today/next nav | `/calendar/page.tsx` |
| ✅ | Local event create / edit / delete | `/calendar/new` + `/calendar/[id]` |
| ✅ | Bidirectional sync to Microsoft 365 | when "Sync to MS" toggle is on |
| ✅ | MS Graph token refresh | works for 1hr+ session lifetimes |
| ✅ | Error-tolerant Graph calls (local write doesn't fail if Graph fails) | logged to App Insights |
| 🟡 | Month view | **M** |
| 🟡 | Day view | **S** |
| 🟡 | Attendees on local events | **M** — schema field exists, no UI |
| 🟡 | Recurrence (RRULE) | **L** |
| 🟡 | Conflict detection ("X is busy") | **M** |
| 🟡 | Multi-calendar (per-user color, per-org calendar) | **M** |
| 🟡 | Drag-to-create / drag-to-reschedule | **L** — needs client-side calendar lib |
| 💤 | iCal feed export | **S** |
| 💤 | Free/busy lookup for cross-team scheduling | **L** |

---

## 7. Time Tracking

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Live timer (start/stop with persisted state) | `components/time/timer-card.tsx` |
| ✅ | Week summary | hours billable vs not |
| ✅ | Submit for approval | per-entry status workflow |
| ✅ | Audit log on each transition | |
| 🟡 | Approver UI for managers (`/time/approvals`) | **M** |
| 🟡 | Bulk approve / reject | **S** |
| 🟡 | Job/Project linkage (currently free-text `jobName`) | **M** — add Project model |
| 🟡 | Payroll CSV export | **S** |
| 🟡 | Per-job profitability report | **M** — needs Project + cost tracking |
| 💤 | GPS-aware clock-in (mobile) | **L** — needs geolocation flow |
| 💤 | Photo capture / job site notes | **L** |

---

## 8. Chat

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Channels (public/private/DM/customer) | schema + sidebar |
| ✅ | Channel view with messages | `(app)/chat/[channelId]/page.tsx` |
| ✅ | Real-time message delivery (SSE) | `api/chat/stream` |
| ✅ | Mock adapter + SignalR adapter (env-driven swap) | `integrations/realtime/` |
| 🟡 | Wire SignalR client-side (replace EventSource) | **M** — replace browser EventSource with `@azure/web-pubsub-client` for prod scale |
| 🟡 | Message threads | **M** — schema has `parentId` |
| 🟡 | Mentions + notifications | **L** — needs notification model |
| 🟡 | File attachments | **M** — depends on Documents/Blob |
| 🟡 | Channel admin UI (create/rename/archive) | **S** |
| ⛔ | **Teams chat bidirectional** | **XXL** — Bot Framework + Teams app manifest + tenant install. Big project. |
| 💤 | Read receipts | **S** |
| 💤 | Emoji reactions | **S** |

---

## 9. Marketing

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Campaign list + summary stats | `(app)/marketing/page.tsx` |
| ✅ | Campaign create form | `/marketing/new` |
| ✅ | Internal-comms tiles ("Coming soon") | placeholder |
| 🟡 | Campaign detail + edit | **M** |
| 🟡 | Send + open-rate + click-rate tracking | **L** — depends on email |
| 🟡 | Audience builder (saved segments → campaign target) | **M** |
| 🟡 | Internal announcements (real, not coming-soon tiles) | **M** |
| 🟡 | SOP / memo library | **M** |
| 🟡 | Recognition feed | **S** |
| 💤 | A/B test framework | **L** |
| 💤 | Drip campaigns | **L** |

---

## 10. Bookkeeping

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Financial period KPI cards | `(app)/bookkeeping/page.tsx` |
| ✅ | Sync button + mock QBO adapter | working with seeded data |
| 🟡 | Real QBO OAuth flow | **L** — `qbo/connect` redirects to Intuit; `/callback` records pending exchange but doesn't actually swap code for tokens yet |
| 🟡 | Real QBO Reports API parse (P&L, Balance Sheet, Cash Flow) | **L** — write tokens into FinancialPeriod rows |
| 🟡 | AR aging report | **M** |
| 🟡 | AP aging report | **M** |
| 🟡 | Per-customer revenue history | **M** |
| 💤 | Invoice creation from CRM | **L** |
| 💤 | Sync expense receipts | **L** |

---

## 11. Documents

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Document list page with folder column | `(app)/documents/page.tsx` |
| ✅ | Schema + Blob container provisioned | `bcc-docs` container in storage account |
| 🟡 | Upload route (`POST /api/documents`) | **M** — multipart parsing + Blob SAS upload OR direct stream |
| 🟡 | Download with signed SAS URL | **S** |
| 🟡 | Folder create / move / delete | **S** |
| 🟡 | Link document to Contact or Deal | **S** — schema fields already exist |
| 🟡 | Drag-and-drop upload UI | **M** |
| 🟡 | Search by name/tag | **S** |
| 💤 | Document preview (PDF / image inline) | **L** |
| 💤 | Versioning | **M** |
| 💤 | OCR / text extraction | **L** |
| 💤 | E-signature integration | **XL** |

---

## 12. Training

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Course catalog list | `(app)/training/page.tsx` |
| ✅ | In-progress card (enrollments) | shown when present |
| 🟡 | Course detail (`/training/[slug]`) with lessons | **M** |
| 🟡 | Lesson player (video + body) | **M** |
| 🟡 | Course authoring (`/training/new` + lesson edit) | **L** |
| 🟡 | Enrollment + progress tracking | **M** |
| 🟡 | Certificates on completion | **M** |
| 💤 | Customer-portal access to public courses | **L** |
| 💤 | Quizzes | **L** |

---

## 13. Events

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Upcoming events list | `(app)/events/page.tsx` |
| ✅ | Event create form | `/events/new` |
| 🟡 | Event detail + edit | **S** |
| 🟡 | RSVP page (public-link no-login version) | **M** |
| 🟡 | Capacity enforcement | **S** |
| 🟡 | Reminders (email/SMS day-before) | **M** — depends on email/SMS |
| 💤 | Ticketing / paid events | **XL** |

---

## 14. Admin Center

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Admin overview (counts + system health) | `(app)/admin/page.tsx` |
| ✅ | Users management (list + role + activate/deactivate) | `/admin/users/page.tsx` |
| ✅ | Audit log viewer | `/admin/audit/page.tsx` |
| ✅ | Integrations grid (grouped by category) | `/admin/integrations/page.tsx` |
| ✅ | Org settings (name/industry/size) | `/admin/settings/page.tsx` |
| ✅ | Knowledge base (placeholder articles) | `/admin/kb/page.tsx` |
| 🟡 | **Integration credentials configurable in-app** | **L** — currently env-driven; rewrite Integration model + admin form to store keys in DB |
| 🟡 | User invite form | **M** |
| 🟡 | Org create / switch (for multi-org admin) | **L** |
| 🟡 | Audit log CSV export | **XS** |
| 🟡 | Audit log retention policy UI | **S** |
| 🟡 | Real KB articles (replace placeholders) | **M** |
| 💤 | Activity dashboard (live ops view) | **L** |

---

## 15. Settings (user)

| Status | Item | Notes / file |
|---|---|---|
| ✅ | Profile (name/phone/title) | `/settings/page.tsx` |
| ✅ | Sign out | server action |
| 🟡 | Avatar upload | **S** — depends on Documents/Blob |
| 🟡 | Notification preferences (email / chat mentions) | **M** |
| 🟡 | Hourly rate (currently read-only) | **XS** |
| 🟡 | Theme toggle (light/dark) | **S** |
| 🟡 | Language / locale | **M** |

---

## Integrations — priority + gating tracker

For each: what we've built locally, what still has to happen on the provider side.

### 📅 Microsoft 365 (Graph)
| Status | Piece | Notes |
|---|---|---|
| ✅ | Entra app registered | client `a3ebdbef-…`, tenant `81acb8ef-…` |
| ✅ | SSO sign-in | Continue with Microsoft 365 button |
| ✅ | Calendar read + write + delete | with token refresh |
| 🟡 | Mail send | **S** — Graph `/me/sendMail` |
| 🟡 | **Mail read (inbox)** | **L** — Graph `/me/messages`; bidirectional needs subscriptions/webhooks |
| 🟡 | Teams presence | **S** — `/users/{id}/presence` |
| ⛔ | **Teams chat bidirectional** | **XXL** — Bot Framework |
| 🟡 | OneDrive file picker | **M** |

### 💵 QuickBooks Online
| Status | Piece | Notes |
|---|---|---|
| ✅ | Connect button + redirect to Intuit OAuth | `/api/integrations/qbo/connect` |
| ✅ | Callback receives code + realmId | `/api/integrations/qbo/callback` |
| 🟡 | Token exchange (POST to oauth.platform.intuit.com) | **S** |
| 🟡 | Token refresh | **S** |
| 🟡 | Reports API: P&L | **M** |
| 🟡 | Reports API: Balance Sheet | **M** |
| 🟡 | Reports API: Cash Flow | **M** |
| 🟡 | Customer sync (QBO → CRM) | **L** |
| 🟡 | Invoice push (CRM Deal → QBO Invoice) | **L** |
| ⛔ **YOU**: | Submit Intuit app for production keys | sandbox keys work for testing; production needs short form |

### 📧 MailChimp
| Status | Piece | Notes |
|---|---|---|
| 🟡 | Admin config UI for API key + audience ID | **S** |
| 🟡 | Adapter (audiences, members, campaigns, send) | **M** |
| 🟡 | Auto-sync new CRM contacts to a Mailchimp audience | **M** |
| 🟡 | Campaign metrics displayed in /marketing | **M** |
| | (No external approval needed) | API is open with a paid Mailchimp account |

### 🟦 Google Ads
| Status | Piece | Notes |
|---|---|---|
| ✅ | Adapter scaffold (mock + live stub) | `integrations/google-ads/` |
| ✅ | Connect endpoint stub | redirects to Admin with notice |
| 🟡 | Real OAuth flow (Google Identity) | **M** |
| 🟡 | Real GAQL queries (campaign + insights) | **L** |
| ⛔ **YOU**: | Apply for Google Ads **developer token** | <https://ads.google.com/aw/apicenter> · 1–3 business day approval typical |
| ⛔ **YOU**: | Create OAuth client at console.cloud.google.com | <5 min once you have a Google Cloud project |

### 🟨 LinkedIn (Marketing API)
| Status | Piece | Notes |
|---|---|---|
| ✅ | Adapter scaffold | `integrations/linkedin/` |
| ✅ | Connect endpoint stub | |
| 🟡 | Real OAuth + token storage | **M** |
| 🟡 | Organic post list + analytics | **M** |
| 🟡 | Sponsored campaign list + metrics | **M** |
| ⛔ **YOU**: | Apply for **Marketing Developer Platform** access | <https://www.linkedin.com/developers/apps> → your app → Products → request access · 24–72h approval |

### 🟪 Meta (Facebook + Instagram)
| Status | Piece | Notes |
|---|---|---|
| ✅ | Adapter scaffold | `integrations/meta/` (one adapter, both surfaces) |
| ✅ | Connect endpoint stub | |
| 🟡 | Real OAuth + long-lived token exchange | **M** |
| 🟡 | List Pages / IG accounts | **S** |
| 🟡 | List posts + insights | **M** |
| 🟡 | List ad campaigns + insights | **M** |
| ⛔ **YOU**: | Submit **App Review** for advanced permissions | typically 1–2 weeks · without it you're capped to 25 test users + dev mode |

### 🌐 WordPress / GoDaddy
❓ **Needs clarification:** what data do you actually want? Pick one or more:

- [ ] Pull contact form submissions from `bluecollarcoach.us` into CRM (most common ask)
- [ ] Push blog posts from BCC Internal to WordPress
- [ ] Manage DNS records via GoDaddy API
- [ ] Track site analytics (visitors, page views)
- [ ] Sync customer signups from a WP membership plugin

Each one is roughly **M** to **L** depending on the plugin/API.

### 💬 Microsoft Teams chat
| Status | Piece | Notes |
|---|---|---|
| 💤 | Bot Framework setup | **XXL** — Azure Bot Service + Teams app manifest + tenant install + app review for org install |
| 💤 | Two-way message bridge | **XXL** |
| | This is the biggest single project on the list | Best to defer until other ducks lined up |

### 💳 Stripe (future)
| Status | Piece | Notes |
|---|---|---|
| 💤 | Connect for payments | **L** |
| 💤 | Subscription billing | **XL** |

---

## Testing & Quality

| Status | Item | Notes |
|---|---|---|
| ✅ | Route smoke test (36 endpoints, HTTP status check) | `scripts/smoke.sh` |
| 🟡 | Vitest unit tests for `lib/`, `server/services/` | **M** |
| 🟡 | Playwright E2E (sign-in → CRM CRUD → calendar event → sign-out) | **L** |
| 🟡 | API contract tests (spec → real responses) | **M** |
| 🟡 | Visual regression (Chromatic / Percy) | **M** |
| 🟡 | Performance budget (Lighthouse CI) | **S** |
| 🟡 | Security headers audit (Mozilla Observatory) | **XS** |
| 💤 | Load test (k6 or Artillery) | **M** |
| 💤 | Accessibility audit (axe) | **M** |

---

## Email / Notifications (cross-cutting)

| Status | Item | Notes |
|---|---|---|
| 🟡 | Pick a transactional provider (ACS / SendGrid / Resend) | **XS** decision, **S** integration |
| 🟡 | Welcome email on first sign-in | **S** |
| 🟡 | Password-reset flow (Auth.js Credentials) | not needed while Entra is the only provider |
| 🟡 | Daily/weekly digest emails | **M** |
| 🟡 | In-app notification center | **L** — new `Notification` model |
| 🟡 | SMS via Twilio / ACS | **M** |
| 🟡 | Push notifications (PWA) | **L** |

---

## Documentation

| Status | File | Purpose |
|---|---|---|
| ✅ | `README.md` | Quick start + module overview |
| ✅ | `docs/architecture.md` | Adapter pattern, multi-tenancy, security |
| ✅ | `docs/integrations.md` | How to set up each provider |
| ✅ | `docs/entra-setup.md` | Click-by-click Entra app registration |
| ✅ | `docs/production-checklist.md` | Pre-launch checklist |
| ✅ | `docs/sql-prod-fixes.sql` | Token column widening (run once) |
| ✅ | `docs/sql-bootstrap-org.sql` | Default Org + OWNER promotion (run once) |
| ✅ | `docs/sql-add-contact-address.sql` | Address columns (run once) |
| ✅ | `docs/sql-clear-stale-users.sql` | Reset wedge from failed OAuth attempts |
| ✅ | `infra/azure/README.md` | Bicep deploy walkthrough |
| ✅ | `styleguide/README.md` | WordPress integration of design system |
| ✅ | `docs/BUILD_SHEET.md` | **This file** |
| 🟡 | `docs/user-guide.md` | End-user onboarding doc |
| 🟡 | `docs/admin-guide.md` | Owner/admin operations guide |
| 🟡 | `CHANGELOG.md` | Per-deploy changelog (currently in git log only) |

---

## Roadmap — proposed batches

Each batch = one redeploy. Items selected to be ~half day to a full day of writing.

**Order (per your call: marketing integrations last):**
B → C → D → G → E → F → H → A → I → J → K → L

### Batch A — Marketing foundation (deferred to LATER per priority call)
- Admin → Integrations: in-app credential storage UI (replaces env vars) · **L** ← *useful for QBO too; could break out earlier if you want*
- MailChimp full integration · **M**
- Marketing module: campaign detail page + edit · **M**
- 1 day total

### Batch B — CRM completeness (← NEXT)
- Company CRUD · **M**
- Deal detail page + edit · **M**
- Activity log per contact · **M**
- CSV export · **S**
- 1 day total

### Batch C — Documents + uploads ✅ shipped 2026-05-23
- ✅ POST `/api/documents` (Blob upload, 25MB cap, mime/size guard)
- ✅ Upload form on `/documents` with folder + tags
- ✅ Per-doc SAS download URL (15min expiry, content-disposition)
- ✅ Folder sidebar + name/tag search
- ✅ Delete (blob + row)
- ⏳ Drag-and-drop UX (still single-file `<input type=file>`)
- ⏳ Link to Contact/Deal (schema has `contactId`/`dealId` cols; UI not wired yet)

### Batch D — Calendar polish
- Month + Day views · **S** + **M**
- Attendees on local events · **M**
- Recurrence (RRULE) · **L**
- 1 day total

### Batch E — QBO real wiring
- Token exchange + refresh · **M**
- P&L Reports API parse · **M**
- Customer sync · **L**
- 1 day, but blocked until you submit Intuit app

### Batch F — Email + Notifications
- Provider integration (ACS recommended) · **S**
- Welcome email · **S**
- Notification center model + UI · **L**
- 1 day total

### Batch G — Time tracking workflow
- Approver queue (`/time/approvals`) · **M**
- Bulk approve · **S**
- Project model + linkage · **M**
- Payroll CSV export · **S**
- 1 day total

### Batch H — Testing
- Playwright E2E · **L**
- Vitest unit tests for services · **M**
- ~1 day total

### Batch I — Google Ads real wiring
- OAuth + token storage · **M**
- GAQL queries + insights mapping · **L**
- Marketing module visualizations · **M**
- 1 day, blocked until developer token approved

### Batch J — LinkedIn real wiring
- Same shape as Google Ads
- Blocked until MDP approval

### Batch K — Meta real wiring
- OAuth + long-lived token + Page/IG account discovery · **M**
- Posts + insights · **M**
- Ad campaigns + insights · **M**
- 1 day, blocked until App Review for any production use beyond test users

### Batch L — Teams chat bridge
- The big one. Defer until you've decided this is actually wanted vs. SignalR-only chat.
- Multi-week.

---

## External actions required (your todo list)

These run on the providers' clocks, not mine. Submitting earlier = faster total throughput.

- [ ] **Google Cloud project** + OAuth client + Google Ads developer token application — start at <https://developers.google.com/google-ads/api/docs/start>
- [ ] **LinkedIn Marketing Developer Platform** access request — your app at <https://www.linkedin.com/developers/apps> → Products
- [ ] **Meta for Developers** app + App Review submission — <https://developers.facebook.com/apps>
- [ ] **Intuit** production keys — <https://developer.intuit.com> → your app → Production keys
- [ ] **MailChimp** account API key (no approval, but need a paid plan for full features)
- [ ] **Custom domain** — confirm you want `internal.bluecollarcoach.us` (or other) so I can wire CNAME + cert
- [ ] **WordPress/GoDaddy use case** — pick from the list in section 14 above
- [ ] **Email provider** — confirm Azure Communication Services vs Resend vs SendGrid

---

## Open questions / decisions parked

- [ ] Multi-tenant from day one? (Schema supports it; UI doesn't expose it.) Right now there's 1 Org. If you'll ever have separate orgs for separate clients, the multi-org switcher becomes important sooner.
- [ ] Customer-facing portal? Schema has CUSTOMER role; no pages yet aimed at them.
- [ ] How long is the audit log retention?
- [ ] Localization (Spanish for trade businesses with bilingual crews)?

---

## Update log

Add a row each push. Keep it brief.

| Date | Batch | Notes |
|---|---|---|
| 2026-05-22 | Initial scaffold | 94 files, infra, 9 modules, admin, auth |
| 2026-05-22 | Bicep tier picker | free/dev/prod SKU switcher |
| 2026-05-22 | BCC-Internal fork | re-themed sibling of BCC Connect |
| 2026-05-22 | Marketing adapters + stylesheet + prod docs | Google Ads, LinkedIn, Meta scaffolds |
| 2026-05-23 | Live on Azure | West US 2, B1, SQL serverless |
| 2026-05-23 | Entra wired | Microsoft 365 sign-in working |
| 2026-05-23 | JWT auto-org + token column widening | fixed sign-in bounce on nav |
| 2026-05-23 | Real PNG brand assets + Cinzel wordmark | favicon + sign-in lockup |
| 2026-05-23 | Punch list deploy | `/marketing/new`, `/events/new`, calendar week nav, Graph token refresh |
| 2026-05-23 | CRM upgrade + calendar bidirectional + smoke test | this build sheet |
| 2026-05-23 | Build sheet committed; marketing-last priority set | `docs/BUILD_SHEET.md` |
| 2026-05-23 | **Batch B**: Company CRUD + Deal create/detail/edit + Contact CSV export | `/crm/companies/*`, `/crm/deals/new`, `/crm/deals/[id]`, `/api/crm/contacts/export` |
| 2026-05-23 | **Batch C**: Documents/Blob upload + SAS download + folder/search | `/documents` upload form, `/api/documents` POST, `/api/documents/[id]/download` SAS redirect, 25MB cap; `@azure/storage-blob` wired |

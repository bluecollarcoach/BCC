# BCC Connect — Discovery

Per the template prompt. Pre-filled with what I already know from our prior
work; unknowns marked **`[NEEDS ANSWER]`**. Edit this file in place and send
it back. I will not write a line of code on the rebuild until this is done.

---

## 1. Company identity

| # | Question | Answer |
|---|---|---|
| 1 | Legal name of the company | **`Blue Collar Coach`** — best guess: "Blue Collar Coach LLC"? |
| 2 | Short brand name for the app icon (≤ 12 chars) | Proposed: **BCC Connect** (matches your "Connect" family — Caliber/Falcon/Precision/BCC). OK? |
| 3 | Primary email domain crews sign in with | `@bluecollarcoach.us` — confirm? |
| 4 | Secondary email domain (often the `.onmicrosoft.com` fallback) | **`bluecollarcoach.onmicrosoft.com`** — typically `bluecollarcoach.onmicrosoft.com`. Check Entra portal → Overview → "Primary domain" — anything in there besides bluecollarcoach.us should be listed too. |
| 5 | Brand colors — primary / secondary / accent | I have: **gold `#a8884a`** (primary), **dark ink `#1A1A1A`** (background/secondary), **chrome/off-white `#f6f6f4`** (accent). Override if wrong. Logo files I already have on disk: `LOGO (1).png` (circle mark) and `BCC_Logo_Full (1).png` (full lockup). Send anything newer/cleaner if you have it. |
| 6 | Tagline / one-line description | Proposed: **"Coaching for blue-collar business owners"** — accurate? |
| 7 | Office address + phones (main + after-hours) | **`(320) 635-6973`** |
| 8 | Headcount (approx); field-vs-office split | **`[NEEDS ANSWER]`** — for a coaching firm I'd guess almost all "office", essentially zero "field". Confirm. |

---

## 2. Modules — yes/no per module

> **IMPORTANT:** BCC is a coaching firm, not a field-service company. The
> BCC Connect template was built for hydrovac/utility crews. Half the
> modules below (T&M sheet, Trucking slip, Inspections, Hydrant inspection,
> Inventory) very likely do **not** apply. The "Coaching-specific" section
> at the bottom proposes the modules I think you actually want — please
> confirm which to include.

### Standard template modules

| # | Module | Include? | Notes |
|---|---|---|---|
| 1 | **Home** (landing page) | ☑ always | Required by template |
| 2 | **My Day** (personal dashboard: Today/Tomorrow/This week, clock in/out, daily log, report issue) | **`Y`** | Useful for coaches even without "field" work — pivots to "today's coaching sessions" |
| 3 | **Scheduler** (calendar with drag-and-drop crew/coach assignment) | **`Y`** | Likely YES — coaches need to schedule sessions; replaces your current MS 365 sync need |
| 4 | **Job Board** (Kanban: New → Scheduled → Today → Waiting → Invoiced → Done) | **`Y`** | Maybe — as a "coaching engagement pipeline" |
| 5 | **T&M Sheet** | **`N`** | Probably NO (no labor/materials/equipment to bill on a sheet) |
| 6 | **Inspections** (DOT pre-trip, equipment walk-around) | **`N`** | Almost certainly NO |
| 7 | **Daily Logs** (split out from My Day) | **`Y`** | Probably keep merged into My Day |
| 8 | **Trucking Slip** | **`N`** | NO unless you have a side hauling business |
| 9 | **Specialty Inspection Forms** | **`N`** | NO unless you have specific paper forms in use — attach PDFs if so |
| 10 | **Maintenance Inbox** | **`N`** | Probably NO unless tracking facility/equipment issues |
| 11 | **Inventory** (parts + supplies, auto shopping list) | **`N`** | Probably NO |
| 12 | **Rate Sheet** (printable, e-signature) | **`Y`** | Maybe YES — coaching package pricing + e-sign |
| 13 | **Chat** (channel-based) | **`Y`** | Likely YES — internal team |
| 14 | **Activity Log** (password-gated audit) | ☑ always | Required by template |
| 15 | **Admin** (Users, Roles, Rates, Equipment, Vehicles, Crews, Lists, Company info) | ☑ always | Required |
| 16 | **How-to Guide** (in-app docs) | ☑ always | Required |

### Coaching-specific modules I think you want (confirm each)

| # | Module | Include? | What it is |
|---|---|---|---|
| C1 | **CRM** (Contacts + Companies + Deals + Pipelines) | **`Y`** | You explicitly asked for this earlier — full address book, regional filter, CSV bulk import. We had it built on Next.js; would rebuild as one HTML page per view (Contacts list, Contact detail, Companies, Deals, Pipeline Kanban). |
| C2 | **Sessions / Coaching Calendar** | **`Y`** | Bidirectional Microsoft 365 calendar sync (you asked for this) — coaching session bookings, prep notes, post-session notes |
| C3 | **Marketing Campaigns** (Google Ads, Meta, LinkedIn, MailChimp, GoDaddy/WordPress — all configurable in admin) | **`Y`** | You explicitly asked for this. Will be a single "Marketing" page with per-channel connectors managed in Admin. |
| C4 | **Bookkeeping** (QBO connector — synced financial KPIs) | **`Y`** | You explicitly asked for this earlier |
| C5 | **Documents** (Azure Blob — contracts, SOPs, customer files) | **`Y`** | We built this on Next.js; would rebuild as one HTML page + the Azure Blob backend stays the same |
| C6 | **Training** (customer-facing courses + playbooks) | **`Y`** | You asked for this. Lessons / enrollments / progress. |
| C7 | **Events** (workshops, meetups, community events with bookings) | **`Y`** | You asked for this |
| C8 | **Knowledge Base (Admin → KB)** | **`Y`** | Internal coaching playbooks for your team |

---

## 3. Identity-specific

| # | Question | Answer |
|---|---|---|
| 17 | **Deploying owner UPN(s)** — the break-glass admin accounts that go in `BCC_OWNER_UPNS` env var (template default `BCC_OWNER_UPNS`, renamed for BCC) | **`lyle@bluecollarcoach.us`** — likely `lyle@bluecollarcoach.us` plus any backup |
| 18 | **Day-1 admins** beyond the first signed-in user | **`lyle@bluecollarcoach.us`** |
| 19 | **Activity-log password default** (visible in code initially, rotate via Admin after first deploy) | Suggest `bcc-audit-2026` — change to whatever you want |

---

## 4. Compliance / industry

| # | Question | Answer |
|---|---|---|
| 20 | **DOT-regulated vehicles?** (only matters if you took the Inspections module) | Almost certainly NO for a coaching firm — confirm |
| 21 | **Customer-facing artifacts that must print clean** (rate sheet, contracts, session summaries, certificates of completion?) | **`Bookkeeping Monthly Report and Annual Report`** — list them and I'll add `@media print` stylesheets per page |
| 22 | **Photo-heavy forms?** | Probably NO for coaching. If you anticipate >20 MB photos per typical document, Blob Storage with SAS URLs (which we already have configured). Confirm. |

---

## 5. Azure / infra

| # | Question | Answer |
|---|---|---|
| 23 | **Azure subscription** | I have: subscription ID `da0f6d99-ee5d-408a-9cfd-0342d257dfb3` ("bluecollarcoach.us"). Reuse, yes? |
| 24 | **Resource group** | I have: `rg-bcc-internal`. Reuse (and clean out the now-stale App Service / SQL Server), or fresh `rg-bcc-connect`? |
| 25 | **Entra tenant** | I have: tenant `81acb8ef-0b0b-4299-882c-ff07373e8cc7`. Reuse, yes? |
| 26 | **Entra app registration** | I have: app `a3ebdbef-feb4-4e39-9a65-6fd891d3cfb4` (named "BCC Internal"). SWA's built-in auth uses its own redirect URI pattern (`/.auth/login/aad/callback`) — different from Auth.js's. We can either: (a) reuse this app reg and add the SWA redirect URI, or (b) create a fresh one named "BCC Connect". Slight preference for (b) for cleanliness. Your call. |
| 27 | **Region** | Template says SWA Free is in `centralus / eastus2 / westus2 / westeurope / eastasia`. Default centralus. OK? |
| 28 | **Custom domain** | **`connect.bluecollarcoach.us`** — recommended `apps.bluecollarcoach.us` or `connect.bluecollarcoach.us`. Confirm CNAME control via your DNS provider (looks like GoDaddy from your earlier comments). |
| 29 | **GitHub repo** | I have: `bluecollarcoach/BCC` on GitHub (currently has the Next.js code I pushed earlier today). **Option A:** wipe `main` and start fresh on the same repo. **Option B:** new repo `bluecollarcoach/bcc-connect`. Your call. | Option B

---

## 6. Constraints

| # | Question | Answer |
|---|---|---|
| 30 | **Concurrency expectation** — how many simultaneous active users? | **`<30`** — coaching firms typically <30 active, so localStorage-first + last-write-wins should be fine. Confirm. |
| 31 | **Offline expectation** — which forms (if any) must work offline? | **`none`** — for a coaching firm, probably "none, we're always online." If you ever do field consultations or workshops without Wi-Fi, list the forms you'd want offline-capable. |
| 32 | **Budget ceiling per month** | Template default $0 (SWA Free + Cosmos Free). I'm assuming that's the ceiling unless you say otherwise. |

---

## 7. Files to attach

If you took any of these modules above, attach the source data so I can seed correctly:

- ☐ Current customer/contact list (CSV or Excel) — if you have one — for CRM seed
- ☐ Coaching rate sheet / package pricing — for Rate Sheet module
- ☐ Any existing contracts / SOPs / templates — for Documents seed
- ☐ Current course/training outlines — for Training module
- ☐ Any paper inspection/intake forms you currently fill out by hand — for Specialty Inspection module (probably none for coaching)

---

## 8. Reference files I need from you

Per the template prompt: "Ask me for the working version of these files from
BCC Connect and adapt them." Please attach (or paste, or share a repo
link):

- ☐ `bcc-api.js` — the ~1200-line shared client layer
- ☐ `api/src/index.js` — the 4-endpoint Azure Functions backend
- ☐ `staticwebapp.config.json`
- ☐ `sw.js` — the service worker
- ☐ `manifest.json`
- ☐ `infra/main.bicep` — the IaC
- ☐ `DEPLOY.md` — your existing runbook
- ☐ `guide.html` — the in-app docs structure
- ☐ For each module BCC opts into above, the corresponding HTML page from BCC Connect — e.g. `myday.html`, `scheduler.html`, `chat.html`, `admin.html` etc. — so I match the patterns exactly.

If easier, just give me read access to the BCC Connect repo on GitHub.

---

## My understanding of what we're building, in plain terms

To prove I read the whole template prompt:

I'm building **BCC Connect** — a multi-page Progressive Web App for Blue
Collar Coach's internal operations, deployed as static HTML + Azure Functions
on Azure Static Web Apps Free + Cosmos DB Free, behind your existing
Microsoft 365 (Entra ID) sign-in. **No framework, no build step.** Each page
is a separate `.html` file. A single shared client script (`bcc-api.js`,
renamed from `bcc-api.js`) is injected into every page and handles:
sign-in/out, user lookup, localStorage-first data with debounced cloud sync
via `PUT /api/data`, GPS capture, weather, toasts, the hamburger drawer, the
shared "New Job"-style modal, audit logging, service worker registration, PWA
manifest injection, and accessibility/touch-target/no-horizontal-scroll
guards.

The API is **four endpoints** (`/api/data`, `/api/profile`, `/api/users`,
`/api/audit`) in one ~500-line Azure Functions v4 file, all wrapped in a
`withAccessLog()` middleware that fire-and-forget writes an access-log doc to
Cosmos on every request. Cosmos has one container, partitioned by
`/tenantId`, with schemaless documents — one doc per localStorage key.

Auth is SWA's built-in OIDC against your Entra tenant. Admin role is
**app-managed** (first signed-in user is admin; thereafter the saved user
list with explicit `role: 'admin'` entries controls it). Break-glass via
`BCC_OWNER_UPNS` env var. Wrong-domain users get bounced to `/403.html`.

Offline-capable forms are pre-cached by `sw.js`; network-first online so
you're never locked into stale code. Print stylesheets on every
customer-facing artifact. GPS on every form submission. Display names
("First Last") everywhere instead of raw UPNs/emails.

Working order per the template: **(1)** I read the prompt back to you
(this doc). **(2)** I state the deploy target (sub, RG, SWA name, hostname)
and wait for OK. **(3)** I sketch the JSON document shape for every opted-in
module and wait for OK. **(4)** I implement in small additive commits on a
feature branch; PR previews; merge to main only after you confirm.
**(5)** Walk every page; label Working / Broken (fixed) / Broken (needs
decision). **(6)** Smoke-test the live URL end-to-end. **(7)** Update
`DEPLOY.md` and `guide.html`.

**Ground rules I'll honor:** no data loss; no functionality lost; no silent
breakage; backwards-compatible by default; diff discipline; state what I'm
about to do, do it, show what changed, flag side effects, wait for input
on ambiguity; no new architectural decisions without asking.

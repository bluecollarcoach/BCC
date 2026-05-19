# Blue Collar Coach **Connect**

> *"You built a business. Now run it like one."*

The operations platform for blue-collar businesses — CRM, calendars, chat, time tracking, financial KPIs, marketing, training, and coaching, in one place. Built on the BCC method of clarity over motivation.

Inspired by Falcon Connect (time tracking), Caliber Connect, and Precision Utilities Connect (chat).
Brand & tone modeled after [bluecollarcoach.us](https://bluecollarcoach.us): dark base (`#1a1a1a`) + gold accent (`#c5a55a`), Georgia serif typography.

---

## What's in this repo

```
src/
  app/                # Next.js App Router pages
    (app)/            # Authenticated app shell
      dashboard/      # KPI dashboard
      crm/            # Contacts, deals, pipeline
      calendar/       # Week view + Microsoft Graph sync
      chat/           # Real-time channels (SSE / SignalR)
      time/           # Timer + crew time tracking
      marketing/      # Campaigns + internal comms
      bookkeeping/    # QBO-synced financial periods
      documents/      # Azure Blob-backed file mgmt
      training/       # Courses + enrollments
      events/         # Workshops, meetups
      settings/       # User profile
    admin/            # Admin Center (OWNER/ADMIN only)
      users/          # Roles management
      audit/          # Audit log viewer
      integrations/   # MS Graph, QBO, SignalR config
    sign-in/          # Auth page
    page.tsx          # Marketing landing
    api/              # Route handlers (auth, chat, qbo, health)
  components/         # UI primitives + feature components
  config/             # Navigation, constants
  integrations/       # Microsoft Graph, QBO, Realtime adapters
                      # (each ships a mock + a live impl; switches on env)
  lib/                # auth, db, logger, audit, rbac, env, utils
  server/services/    # Business logic (contacts, time, chat, kpis)
prisma/schema.prisma  # All data models (Org, User, Contact, Deal, TimeEntry,
                      # ChatChannel/Message, CalendarEvent, Document, Campaign,
                      # Course, FinancialPeriod, Integration, AuditLog)
scripts/seed.ts       # Demo data: Castro Mechanical + crew + deals + finances
infra/azure/          # Bicep templates for full Azure provisioning
.github/workflows/    # CI/CD to Azure App Service
```

---

## Quick start (local)

Prereqs: **Node 20+**.

```bash
# 1. Install deps
npm install

# 2. Configure env (dev defaults are safe)
cp .env.example .env
#   Defaults: SQLite, DEV_AUTH_BYPASS=true, mock integrations.

# 3. Initialise the DB and seed demo data
npm run db:push
npm run db:seed

# 4. Run the app
npm run dev
```

Open <http://localhost:3000>.
Sign in with **owner@bluecollarcoach.us** (dev bypass — no password). Try:

- `/dashboard` — KPIs, revenue chart, attention queue
- `/crm` — contacts, deals pipeline
- `/time` — start a timer, watch it tick, stop it, submit for approval
- `/chat/<channel>` — multi-tab realtime (SSE)
- `/calendar` — week view with mock Microsoft events
- `/bookkeeping` — QBO-style financials (mock data)
- `/admin` — Owners/Admins only

---

## The integrations layer

All three external integrations follow the same pattern:

```
src/integrations/<provider>/
  adapter.ts   # interface
  mock.ts      # used when env not configured (default in dev)
  <real>.ts    # production implementation
  index.ts     # exports the right one based on env vars
```

| Integration | Env variables | Adapter file | Status |
| --- | --- | --- | --- |
| Microsoft Graph (calendar) | `AUTH_MICROSOFT_ENTRA_ID` + `AUTH_MICROSOFT_ENTRA_SECRET` | `microsoft-graph/graph.ts` | Live impl (read + create + update + delete events). Token refresh = TODO. |
| QuickBooks Online | `QBO_CLIENT_ID` + `QBO_CLIENT_SECRET` | `qbo/qbo.ts` | OAuth scaffold + stubbed Reports API. Wire the actual P&L/BalanceSheet fetch here. |
| Realtime / SignalR | `SIGNALR_CONNECTION_STRING` | `realtime/signalr.ts` | Stubbed publish/subscribe. Replace with `@azure/web-pubsub-express`. |

Auth uses **Auth.js (NextAuth v5)** with the Microsoft Entra ID provider. The Prisma adapter persists the OAuth tokens in `Account`; the Graph client reads them at request time. A `DEV_AUTH_BYPASS=true` credentials provider exists for local dev — disabled in production.

---

## Deploying to Azure

Everything is wired up. Follow [`infra/azure/README.md`](infra/azure/README.md) for the full walkthrough. Short version:

```bash
az group create --name rg-bcc-connect --location eastus
# Edit infra/azure/main.parameters.json (sqlAdminPassword, authSecret, optional Entra/QBO)
az deployment group create \
  --resource-group rg-bcc-connect \
  --template-file infra/azure/main.bicep \
  --parameters @infra/azure/main.parameters.json
```

Then connect GitHub Actions (see `.github/workflows/deploy.yml`) — uses OIDC, no long-lived secrets.

---

## Roles & permissions (RBAC)

| Role | Description |
| --- | --- |
| **OWNER** | Founder. Full access to admin + all data. |
| **ADMIN** | Org admin. Manage users, integrations, see audit log. |
| **COACH** | BCC coach (internal). Read all CRM/time, manage campaigns, author training. |
| **STAFF** | Client crew. Use chat, time tracker, see own work + customer-facing CRM. |
| **CUSTOMER** | External customer using the portal. (Training, events, scoped docs.) |

Capabilities are defined in `src/lib/rbac.ts`. The middleware in `src/middleware.ts` enforces `/admin` access at the edge; pages re-check on the server.

---

## Logging & audit

- **Application telemetry** → Azure Application Insights via `@/lib/logger`. Falls back to console when not configured.
- **Audit log** → every privileged mutation (`contact.create`, `time.approve`, `user.role.update`, ...) writes a row to `AuditLog`. Viewable at `/admin/audit`. Best-effort writes never block the user-facing request.

---

## What's *not* yet wired (honest list)

This scaffold gets you to a runnable, demo-able product. The following items still need implementation for production:

1. **MS Graph token refresh** — stored refresh tokens aren't yet exchanged automatically when access tokens expire (15 min lifetime).
2. **QBO Reports API parsing** — OAuth flow + token storage is wired; the Reports → `FinancialPeriod` mapping is a stub.
3. **Azure Blob document uploads** — schema and UI exist; the actual upload route (`POST /api/documents`) needs to be added (SAS token issuance pattern).
4. **SignalR client wiring** — the mock adapter uses SSE; swap `EventSource` for the Azure Web PubSub client in `channel-view.tsx` when you switch on `SIGNALR_CONNECTION_STRING`.
5. **Email** — Azure Communication Services connection string slot exists; transactional email sender not yet built.
6. **PWA / install prompts** — the responsive shell is mobile-first; add a manifest + service worker for installability.
7. **Tests** — none in this scaffold. Suggested: Vitest + Playwright (visual + integration).

Everything else — auth, CRM, time tracking, chat (with realtime), calendar (with sync wired), bookkeeping UI, admin, audit, logging, infra — works end-to-end.

---

## Stack

- **Next.js 15** (App Router, Server Actions, RSC) on **React 19**
- **TypeScript** strict
- **Tailwind CSS** with brand tokens in `tailwind.config.ts`
- **Prisma 5** ORM (SQLite dev → Azure SQL prod)
- **Auth.js v5** (NextAuth) with Entra ID + dev bypass
- **Recharts** for KPI visualisations
- **lucide-react** icons
- **Zod** for input validation
- **Application Insights** for logging (server + browser)
- **Azure App Service**, **Azure SQL**, **SignalR Service**, **Blob Storage**, **App Insights**

---

## License

Proprietary © Blue Collar Coach. All rights reserved.

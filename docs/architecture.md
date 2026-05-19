# Architecture

## Request flow

```
Browser
  │
  ├── HTML / RSC payloads ──→ Next.js App Router (src/app/)
  │                                │
  │                                ├── middleware.ts (auth gate, /admin role check)
  │                                ├── (app)/layout.tsx (resolves session)
  │                                └── page.tsx (server-render w/ services + Prisma)
  │
  ├── /api/* route handlers ──→ Node runtime
  │                                ├── /api/auth/[...nextauth] (Auth.js)
  │                                ├── /api/chat/messages (POST a message)
  │                                ├── /api/chat/stream (SSE subscribe)
  │                                ├── /api/integrations/qbo/connect|callback
  │                                └── /api/health
  │
  └── Realtime (SSE today / SignalR in prod) ──→ realtime adapter
```

## Adapter pattern for integrations

Each external service has the same three files:

```
adapter.ts   ← TypeScript interface
mock.ts      ← in-memory implementation used in dev/CI
<real>.ts    ← production implementation (graph.ts, qbo.ts, signalr.ts)
index.ts     ← exports the right one based on env presence
```

Why: lets the entire app (services, pages, tests) consume one stable interface. Swapping a mock for a live adapter is one env var. Tests don't need network.

## Auth chain

1. User hits a protected route → `middleware.ts` checks `auth()` → redirect to `/sign-in` if absent.
2. Sign-in form → `signIn()` server action → Auth.js delegates to provider.
3. Microsoft Entra returns OAuth tokens → `PrismaAdapter` persists to `Account`.
4. JWT callback enriches the token with `role` + `orgId` from the DB.
5. Subsequent requests resolve `session.user.{id, role, orgId}` directly from the JWT.
6. Microsoft Graph calls read `account.access_token` for the current user.

## Data model groupings

| Module | Models |
| --- | --- |
| Auth/RBAC | `Org`, `User`, `Account`, `Session`, `VerificationToken` |
| CRM | `Company`, `Contact`, `Pipeline`, `PipelineStage`, `Deal`, `Activity` |
| Time | `TimeEntry` |
| Chat | `ChatChannel`, `ChannelMember`, `ChatMessage` |
| Calendar | `CalendarEvent` (LOCAL + mirrors from MSGRAPH) |
| Documents | `Document` (storageKey → Azure Blob) |
| Marketing | `Campaign` |
| Events | `EventBooking` |
| Training | `Course`, `Lesson`, `Enrollment` |
| Bookkeeping | `FinancialPeriod` (cache layer over QBO Reports) |
| Platform | `Integration` (OAuth tokens), `AuditLog` |

## Multi-tenancy

Every domain row carries an `orgId`. Service functions take `orgId` as their first arg and filter all queries by it. The session enriches `session.user.orgId` at JWT mint time. There's no cross-org access path that bypasses this — even admin pages scope by the actor's `orgId`.

## Realtime chat

- **Dev/CI**: in-memory pub/sub fanned out over Server-Sent Events. Single Next.js instance only.
- **Prod**: Azure SignalR Service (Serverless mode). Clients negotiate a connection token from `/api/chat/negotiate` (TODO), then connect directly to SignalR. The server-side adapter only publishes; subscriptions stay browser-side.

## Observability

- **Telemetry**: `applicationinsights` Node SDK collects requests, dependencies, exceptions automatically. The `logger` helper wraps `trackTrace` / `trackException` / `trackEvent`.
- **Audit**: every mutation in service code emits an `AuditLog` row + an `info` log line tagged `audit:<action>`.
- **Health**: `GET /api/health` returns DB connectivity + integration configuration status. Wire into Azure App Service health checks.

## Security posture

- HTTPS-only at the App Service edge (`httpsOnly: true` in Bicep).
- Cookies marked `secure` + `httpOnly` by Auth.js.
- CSRF protection via Auth.js double-submit token.
- Strict Content-Type/Frame/Referrer headers in `next.config.ts`.
- Permissions-Policy locks camera/mic by default.
- SQL injection: Prisma parameterises everything; no raw SQL on user input.
- Secrets: env-only (Key Vault references recommended for prod).
- RBAC: defence in depth — middleware → layout → service function.
- Audit log retained per Azure App Insights policy (90d default).

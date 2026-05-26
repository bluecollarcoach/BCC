# BCC Connect

Operations workspace for the **Blue Collar Coach** team — CRM, coaching
sessions, jobs board, chat, training, documents, and admin in one place.
Built on the same template as the rest of the **Connect** family
(Precision Connect, Caliber Connect, Falcon Connect): static HTML + Azure
Functions + Cosmos DB + Static Web Apps Free, gated by Microsoft 365
(Entra ID) sign-in.

## Stack

- **Frontend:** plain HTML per page, no framework, no build step
- **Shared client layer:** `bcc-api.js` (~1400 lines) injected into every page
- **Backend:** Azure Functions v4 (Node 20), all endpoints in `api/src/index.js`
- **Database:** Cosmos DB Free tier, single container, schemaless docs
  partitioned by `/tenantId`
- **Auth:** SWA built-in Entra ID OIDC; admin role app-managed
- **Offline:** Service worker pre-caches the highest-traffic pages
- **Hosting:** Azure Static Web Apps Free + Cosmos DB Free = $0/mo

## Layout

```
.
├── *.html              one page per module (index, myday, scheduler, crm, ...)
├── bcc-api.js          shared client layer
├── sw.js               service worker (offline cache)
├── manifest.json       PWA manifest
├── staticwebapp.config.json  SWA routes + auth
├── 403.html            access denied
├── api/                Azure Functions
│   └── src/index.js    all endpoints
├── infra/              Bicep IaC + deploy scripts
└── DEPLOY.md           runbook
```

## Local dev

You can't really run a SWA app locally without the SWA CLI + Functions Core
Tools. Easiest workflow is: push to a feature branch, let Vercel/SWA build
the preview URL, click through there. See `DEPLOY.md` for one-time setup.

## Discovery

Architectural decisions and module inclusions are in `docs/DISCOVERY-BCC.md`.

## Reference implementation

This codebase is a sibling of [bluecollarcoach/precision-connect](https://github.com/bluecollarcoach/precision-connect).
When in doubt about a pattern, check there first.

# Production readiness checklist

Run through this before you point real users at the deployed app. Most items are 30s each; a few require Azure portal clicks.

## Secrets & auth

- [ ] `DEV_AUTH_BYPASS=false` in App Service config (and in your `.env` if anyone else touches the box). With this `true` in prod, anyone who can guess an email is in.
- [ ] `AUTH_SECRET` is set to a unique 32+ byte value (`openssl rand -base64 32`). Not the dev default. Not shared between staging and prod.
- [ ] Entra app registration complete and `AUTH_MICROSOFT_ENTRA_*` env vars populated. See `entra-setup.md`.
- [ ] Entra redirect URIs include both the `.azurewebsites.net` host and any custom domain.
- [ ] Sign-in works end-to-end with a real Microsoft account before you invite anyone else.

## Database

- [ ] `DATABASE_URL` points at the production Azure SQL DB, not the dev SQLite file. (`sqlserver://...:1433/...?encrypt=true`)
- [ ] Migrations applied: `DATABASE_URL=... npx prisma migrate deploy`
- [ ] Seed data is **NOT** loaded in prod (the seed script creates Castro Mechanical demo data — only for dev).
- [ ] At least one human OWNER user exists (created via the first Entra sign-in, then promoted in Admin → Users).
- [ ] SQL Server firewall: only Azure services + your office IP whitelisted. No `0.0.0.0/0` for "All".

## Observability

- [ ] `APPLICATIONINSIGHTS_CONNECTION_STRING` set in App Service config.
- [ ] Test: hit `/api/health` from your machine, then check Application Insights → Logs → `traces` for a row in the last 5 minutes.
- [ ] Test: trigger an error (e.g. fetch a non-existent contact) and verify it appears in App Insights → Failures.
- [ ] Set up an alert rule for HTTP 5xx > 10/min (Azure Monitor → Alerts).

## Network & domain

- [ ] HTTPS only enforced (Bicep already sets `httpsOnly: true`).
- [ ] If using a custom domain (e.g. `internal.bluecollarcoach.us`):
  - DNS CNAME → `<app-name>.azurewebsites.net` created
  - Custom domain bound in App Service → Custom domains
  - Managed certificate issued (free; Azure handles renewal)
  - Entra redirect URI updated to match
- [ ] Redirect bare `<app>.azurewebsites.net` → custom domain (optional but recommended for SEO + auth coherence).

## Search engine hygiene

The app already sets `robots: { index: false, follow: false }` in metadata, but belt-and-suspenders:

- [ ] `public/robots.txt`:
  ```
  User-agent: *
  Disallow: /
  ```
- [ ] No public landing page (it's a redirect — confirm).
- [ ] Custom domain NOT added to Google Search Console (prevents accidental indexing requests).

## Integrations (light-up checklist)

When you're ready to flip each on, fill in env vars in App Service → Configuration → Application settings, then restart the app:

- [ ] **QBO**: `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / set `QBO_ENVIRONMENT=production`. Connect from Admin → Integrations.
- [ ] **Google Ads**: requires developer token approval from Google (1–3 days). Start the application now even if you're not using it yet.
- [ ] **LinkedIn**: requires Marketing Developer Platform approval (faster — usually < 24h).
- [ ] **Meta**: works in test mode with up to 25 added testers immediately. Full release requires App Review (variable, sometimes 1–2 weeks).
- [ ] **SignalR**: already provisioned by Bicep; the connection string is auto-injected. Verify with: open two browser windows, post a chat message in one, see it appear in the other in < 1s.

## Data & backups

- [ ] Azure SQL automated backups enabled (default: 7-day point-in-time restore on serverless tier).
- [ ] Note the LTR (long-term retention) policy if you need compliance retention. Off by default.
- [ ] Blob Storage: set a lifecycle rule to move docs to Cool tier after 90 days if you anticipate volume.

## Performance smoke test

- [ ] First load (cold): < 5s on broadband. (SQL serverless wake-up dominates this.)
- [ ] Subsequent loads: < 800ms.
- [ ] Chat message latency: < 500ms between two browser tabs.
- [ ] Dashboard renders 6 KPI cards + revenue chart: < 1.5s.

If anything's off, check:
- App Service Plan SKU (F1 is too small for prod; bump to B1 or higher)
- SQL auto-pause delay (60s is fine for low traffic; bump to 0 / disable for prod if you have a real user base)
- App Insights → Performance for the slow endpoint

## Pre-launch communication

- [ ] Tell your team where to sign in.
- [ ] First sign-in for each person creates their User row with `role: STAFF`. As Owner, you'll need to promote them in Admin → Users if they should be ADMIN or COACH.
- [ ] Document the URL, sign-in flow, and "who to ping if it breaks" somewhere your team will find it.

## After launch

- [ ] Check Application Insights → Live Metrics during the first few users' sessions.
- [ ] Set a calendar reminder ~50 days out to rotate the Entra client secret if you picked 24mo expiry.
- [ ] Set a calendar reminder ~5 days before any OAuth refresh token expiry on QBO/LinkedIn/Meta to test that auto-refresh is working.

---

If you'd like, I can also generate:
- A Bicep diff that flips the SKU from `free` to `dev` (~$25/mo, no cold starts) for production-real use
- A `scripts/seed-prod.ts` that creates only the Org + Owner row (no demo data) for a clean first deploy
- Synthetic monitoring (a 5-minute Azure Monitor "URL ping test" against `/api/health`)

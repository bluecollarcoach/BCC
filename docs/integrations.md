# Wiring up integrations

## Microsoft Entra (auth + Microsoft Graph)

1. Open <https://entra.microsoft.com> → **App registrations** → **New registration**
2. Name: `BCC Connect`
3. **Redirect URI (Web)**: `https://<your-host>/api/auth/callback/microsoft-entra-id`
   - Also add `http://localhost:3000/api/auth/callback/microsoft-entra-id` for dev.
4. After creation, copy **Application (client) ID** and **Directory (tenant) ID**.
5. **Certificates & secrets** → **New client secret** → copy the value (you'll never see it again).
6. **API permissions** → Add → Microsoft Graph → **Delegated**:
   - `User.Read`
   - `offline_access`
   - `Calendars.ReadWrite`
   - `Mail.Send` (optional)
   - Then click **Grant admin consent**.

Set in `.env`:

```env
AUTH_MICROSOFT_ENTRA_ID=<client-id>
AUTH_MICROSOFT_ENTRA_SECRET=<client-secret>
AUTH_MICROSOFT_ENTRA_TENANT_ID=<tenant-id>   # or "common" for multi-tenant
DEV_AUTH_BYPASS=false
```

Restart. The "Continue with Microsoft" button now appears on `/sign-in`, and calendar reads/writes hit Graph instead of the mock.

### Token refresh (TODO)

The current `src/integrations/microsoft-graph/graph.ts` reads the stored access token but does not yet refresh it. To finish:

```ts
// Pseudocode:
if (expired(account)) {
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: env.AUTH_MICROSOFT_ENTRA_ID,
      client_secret: env.AUTH_MICROSOFT_ENTRA_SECRET,
      scope: env.MS_GRAPH_SCOPES,
    }),
  }).then(r => r.json());
  await prisma.account.update({
    where: { id: account.id },
    data: { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: ... },
  });
}
```

## QuickBooks Online

1. <https://developer.intuit.com> → **Apps** → **Create app** → **Accounting**
2. **Keys & credentials** → grab Client ID + Client Secret (use Development for sandbox).
3. **Redirect URI**: `https://<your-host>/api/integrations/qbo/callback` (also add localhost variant).

Set in `.env`:

```env
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REDIRECT_URI=https://<your-host>/api/integrations/qbo/callback
QBO_ENVIRONMENT=sandbox
```

In the app, go to **Admin → Integrations → QuickBooks → Connect**. You'll be redirected to Intuit, authorize, and bounced back to the callback. The callback writes a `PENDING_TOKEN_EXCHANGE` Integration row. Finishing that exchange is the next implementation step (see `src/app/api/integrations/qbo/callback/route.ts`).

To finish: POST to `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with Basic auth (`{client_id}:{client_secret}` base64), body `grant_type=authorization_code&code=...&redirect_uri=...`. Persist `access_token`, `refresh_token`, `realmId` into the `Integration` row, status → `CONNECTED`.

The Reports API endpoints we want:

- `GET /v3/company/{realmId}/reports/ProfitAndLoss?start_date=...&end_date=...&accounting_method=Accrual`
- `GET /v3/company/{realmId}/reports/BalanceSheet?as_of=...`
- `GET /v3/company/{realmId}/reports/CashFlow?start_date=...&end_date=...`

Map the `Header` + `Rows.Row[]` arrays into `FinancialPeriod` rows in `src/integrations/qbo/qbo.ts:monthlyKpis()`.

## Azure SignalR Service (realtime)

The mock realtime adapter works fine in single-instance dev. In Azure App Service with auto-scale, switch to SignalR.

1. Provisioned by the Bicep template — connection string is auto-injected into the App Service config (`SIGNALR_CONNECTION_STRING`).
2. The `realtime` export in `src/integrations/realtime/index.ts` will pick up `signalRRealtime` automatically.
3. Wire the browser client: replace `EventSource` in `src/components/chat/channel-view.tsx` with `@azure/web-pubsub-client` (or `@microsoft/signalr` for traditional hubs). Use the URL/token from `realtime.issueClientToken(userId)`.

## Application Insights

1. Provisioned by Bicep — connection string injected as `APPLICATIONINSIGHTS_CONNECTION_STRING`.
2. Server-side: `src/lib/logger.ts` initialises the SDK on first use. All `logger.info/error/event` calls flow to App Insights.
3. Browser-side: set `NEXT_PUBLIC_APPINSIGHTS_CONNECTION_STRING` to the same value to enable client-side telemetry. (Loader not yet added to `app/layout.tsx` — add `@microsoft/applicationinsights-web` initialisation in a top-level client component if desired.)

## Azure Blob Storage (documents)

1. Provisioned by Bicep — connection string injected as `AZURE_STORAGE_CONNECTION_STRING`.
2. The Documents page reads `Document` rows. Upload route is the next implementation step:
   - `POST /api/documents` accepts `multipart/form-data`, generates a key like `${orgId}/${uuid}-${filename}`, streams to the `bcc-docs` container, creates a `Document` row.
   - Or issue a SAS upload token client-side for direct browser uploads (preferred for files >4MB).

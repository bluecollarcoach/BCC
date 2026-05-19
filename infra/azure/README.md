# Azure deployment

This folder provisions everything Blue Collar Coach Connect needs to run on Azure:

| Resource | Purpose |
| --- | --- |
| App Service Plan (Linux) | Hosts the Next.js app |
| Web App | The app itself (Node 20) |
| Azure SQL Server + Database (Serverless GP_S_Gen5_2) | Primary datastore |
| Azure SignalR Service (Serverless S1) | Realtime chat |
| Application Insights | Logging, telemetry, exceptions |
| Storage Account + `bcc-docs` container | Document uploads |

## Prereqs

- Azure subscription & contributor rights
- `az` CLI signed in: `az login`
- A resource group: `az group create --name rg-bcc-connect --location eastus`

## Deploy

```bash
# Edit infra/azure/main.parameters.json first — set sqlAdminPassword + authSecret.
az deployment group create \
  --resource-group rg-bcc-connect \
  --template-file infra/azure/main.bicep \
  --parameters @infra/azure/main.parameters.json
```

The deployment outputs the App Service URL, SQL FQDN, App Insights connection string, and SignalR hostname. Copy these into your CI/CD pipeline secrets.

## First run after provision

```bash
# From your machine, with the SQL admin firewall opened to your IP:
DATABASE_URL="sqlserver://...your-azure-sql-conn..." npx prisma migrate deploy
DATABASE_URL="..." npx tsx scripts/seed.ts
```

## App registration (Microsoft Entra)

1. Visit https://entra.microsoft.com → App registrations → New
2. Redirect URI (Web): `https://<your-app>.azurewebsites.net/api/auth/callback/microsoft-entra-id`
3. API permissions → Microsoft Graph (delegated): `User.Read`, `Calendars.ReadWrite`, `Mail.Send`, `offline_access`
4. Certificates & secrets → New client secret → copy the value
5. Set `entraClientId` + `entraClientSecret` in `main.parameters.json`, redeploy (or use `az webapp config appsettings set`)

## QuickBooks Online

1. https://developer.intuit.com → Create app (Accounting)
2. Redirect URI: `https://<your-app>.azurewebsites.net/api/integrations/qbo/callback`
3. Copy client id + secret into `main.parameters.json`
4. In the app, go to Admin → Integrations → Connect QuickBooks

## Custom domain (optional)

```bash
az webapp config hostname add \
  --webapp-name <app-name> \
  --resource-group rg-bcc-connect \
  --hostname connect.bluecollarcoach.us
```

Then add the TLS binding (managed certificate is free).

## Scaling notes

- The Serverless SQL DB auto-pauses after 60s of inactivity. First request after a pause takes ~10s to warm up. Switch to `GP_Gen5_2` (provisioned) for production.
- For >50 concurrent chat users, scale the SignalR service to `Standard_S2` and bump the App Service to `P1v3` or higher.
- Application Insights retention is 90 days by default. Adjust via the portal.

## Secrets best practice

Don't keep secrets in `main.parameters.json`. Use Key Vault references:

```bicep
{ name: 'AUTH_SECRET', value: '@Microsoft.KeyVault(SecretUri=https://kv-bcc.vault.azure.net/secrets/auth-secret/)' }
```

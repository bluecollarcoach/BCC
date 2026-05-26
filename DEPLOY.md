# BCC Connect — Azure deployment runbook

Goal: ship this app to your existing Azure subscription, on free-tier resources, with Entra ID single sign-on and data in Cosmos DB. Follow the steps below top-to-bottom. Anything in `<angle-brackets>` is something you fill in.

## What gets built

```
Browser (any device, signed in via Entra ID)
      │
      ▼
Azure Static Web Apps  (Free SKU — hosts the HTML/CSS/JS + the API)
      │
      │  (built-in /.auth/me — no auth code in the app)
      │
      ▼
api/  Azure Functions (Node.js 20, runs inside the SWA, free quota)
      │
      ▼
Azure Cosmos DB  (Free Tier: 1000 RU/s + 25 GB free forever, one container)
```

* **Hosting cost**: $0/mo for typical usage (SWA Free + Cosmos free tier + Functions inside SWA quota).
* **Custom domain**: free SSL on `app.bluecollarcoach.us` (or any subdomain you choose).
* **Auth**: Entra ID (Azure AD). Optional MFA / conditional access via your existing Entra policies.

## Prerequisites

1. **Azure subscription** with permission to create resource groups, Cosmos DB, and Static Web Apps. (You have one.)
2. **GitHub account** with a repo you can push this code to. Static Web Apps deploys from GitHub.
3. **Azure CLI** locally, signed in:
   ```powershell
   az login
   az account set --subscription "<your-subscription-id>"
   ```
4. **PowerShell 7+** or **bash**. Both `deploy.ps1` and `deploy.sh` are provided.

## Step 1 — Push the code to GitHub

If you haven't already:

```powershell
cd "C:\Users\Apric\Downloads\Blue Collar Coach"
git init
git add .
git commit -m "Initial bcc-connect"
git branch -M main
git remote add origin https://github.com/bluecollarcoach/BCC.git
git push -u origin main
```

The folder layout in the repo should be:

```
/
├── .github/workflows/azure-static-web-apps.yml
└── (project root)/
    ├── *.html
    ├── bcc-api.js
    ├── bcc-logo.png
    ├── staticwebapp.config.json
    ├── api/                       (Azure Functions)
    ├── infra/                     (Bicep)
    └── DEPLOY.md                  (this file)
```

## Step 2 — Create a GitHub personal access token

The Bicep template needs a PAT to wire the SWA up to your repo for CI/CD.

1. https://github.com/settings/tokens → **Generate new token (classic)**.
2. Scopes: **repo**, **workflow**. Expiry: whatever fits your policy.
3. Copy the token (`ghp_...`). You'll pass it once to the deploy script.

## Step 3 — Register the app in Entra ID

The SWA uses this app registration to sign users in.

```powershell
$TENANT_ID = (az account show --query tenantId -o tsv)
$APP_NAME = "BCC Connect"

# Create the app registration
$APP_ID = (az ad app create `
  --display-name $APP_NAME `
  --sign-in-audience AzureADMyOrg `
  --web-redirect-uris "https://<placeholder>.azurestaticapps.net/.auth/login/aad/callback" `
  --query appId -o tsv)

# Add a client secret (valid for 24 months)
$APP_SECRET = (az ad app credential reset `
  --id $APP_ID `
  --display-name "swa-client-secret" `
  --years 2 `
  --query password -o tsv)

# Required ID-token claims (so we get the upn/email back)
az ad app update --id $APP_ID --set optionalClaims=@'{ "idToken": [ { "name": "upn", "essential": false }, { "name": "email", "essential": false } ], "accessToken": [], "saml2Token": [] }'@

# Make sure the app can request openid + profile + email
az ad app permission add --id $APP_ID `
  --api 00000003-0000-0000-c000-000000000000 `
  --api-permissions 7427e0e9-2fba-42fe-b0c0-848c9e6a8182=Scope `
                    14dad69e-099b-42c9-810b-d002981feec1=Scope `
                    37f7f235-527c-4136-accd-4a02d197296e=Scope
az ad app permission grant --id $APP_ID --scope "openid profile email" --api 00000003-0000-0000-c000-000000000000

Write-Host "TENANT_ID:    $TENANT_ID"
Write-Host "CLIENT_ID:    $APP_ID"
Write-Host "CLIENT_SECRET: $APP_SECRET (save this — you won't see it again)"
```

Save these three values. You'll need them in step 4 *and* you'll come back to add the **real** redirect URI in step 6 (after the SWA's hostname is known).

## Step 4 — Deploy the infrastructure

From the repo root (or `infra/`):

**PowerShell:**
```powershell
cd infra
./deploy.ps1 `
  -Subscription      "<your-subscription-id>" `
  -ResourceGroup     rg-bcc-internal `
  -Location          centralus `
  -RepoUrl           "https://github.com/bluecollarcoach/BCC" `
  -RepoToken         "<ghp_token_from_step_2>" `
  -EntraTenantId     "<TENANT_ID from step 3>" `
  -EntraClientId     "<CLIENT_ID from step 3>" `
  -EntraClientSecret "<CLIENT_SECRET from step 3>"
```

**bash:**
```bash
cd infra
export SUBSCRIPTION_ID="<your-subscription-id>"
export RESOURCE_GROUP=rg-bcc-internal
export REPO_URL="https://github.com/bluecollarcoach/BCC"
export REPO_TOKEN="<ghp_token_from_step_2>"
export ENTRA_TENANT_ID="<TENANT_ID>"
export ENTRA_CLIENT_ID="<CLIENT_ID>"
export ENTRA_CLIENT_SECRET="<CLIENT_SECRET>"
./deploy.sh
```

After ~3 minutes you'll see:

```
swaDefaultHostname: <something>.azurestaticapps.net
```

Copy that hostname.

> **Cosmos DB Free Tier note:** only one Cosmos account per subscription can have free-tier enabled. If the deployment errors out with "free tier already used," pass `-EnableCosmosFreeTier $false` (PowerShell) or `ENABLE_COSMOS_FREE_TIER=false ./deploy.sh`. The DB will then cost about $0.025/hour ≈ $18/month for the minimum 400 RU/s.

## Step 5 — Update the Entra app's redirect URI

Now that we know the SWA's hostname, update the app registration:

```powershell
$SWA_HOSTNAME = "<paste-from-step-4>.azurestaticapps.net"
az ad app update --id $APP_ID `
  --web-redirect-uris "https://$SWA_HOSTNAME/.auth/login/aad/callback"
```

## Step 6 — Patch the SWA config with your tenant ID

Open [staticwebapp.config.json](./staticwebapp.config.json) and replace `AZURE_TENANT_ID` (the literal string in the `openIdIssuer` field) with the GUID from step 3. Commit & push:

```powershell
cd ..
git add staticwebapp.config.json
git commit -m "Wire Entra tenant into SWA config"
git push
```

That push kicks the GitHub Actions workflow ([.github/workflows/azure-static-web-apps.yml](../.github/workflows/azure-static-web-apps.yml)), which deploys the static files + the API to Azure.

> **First-time deploy may need the deployment token.** If the Action fails with "AZURE_STATIC_WEB_APPS_API_TOKEN is not set," go to Azure Portal → Static Web App → **Manage deployment token**, copy the value, and add it as a secret named `AZURE_STATIC_WEB_APPS_API_TOKEN` on your GitHub repo (Settings → Secrets and variables → Actions). Then re-run the workflow.

## Step 7 — Invite users with roles

Static Web Apps doesn't know who in your Entra tenant should be an admin; you assign roles per user. Two ways:

### A. Quick: invite a handful of admins via the portal

1. Azure Portal → Static Web App → **Role management** → **Invite**.
2. Invitee details: their Entra email, role = `administrator`.
3. They get an email with an acceptance link. After they accept and sign in, they have the role.
4. Repeat for `authenticated` (read-only) users if you want to be explicit; otherwise everyone with an Entra account in your tenant gets `authenticated` automatically once they sign in.

### B. Programmatic: assign via Entra group claim (recommended at scale)

Use the **role-claims function** pattern. Create an Azure Function in the API that runs once per sign-in to map the user's Entra group membership to SWA roles. The skeleton for that function is on the roadmap (v0.3) — for now, the portal-based invitation flow is fine for the team's size.

## Step 8 — Custom domain (optional but recommended)

```powershell
# Get an instruction for the DNS validation record:
az staticwebapp hostname set `
  --name bcc-connect-swa `
  --resource-group rg-bcc-internal `
  --hostname app.bluecollarcoach.us
```

Add the printed CNAME or TXT record in your DNS provider. SSL is auto-provisioned (free Let's Encrypt). Also update the redirect URI in Entra to include the custom domain:

```powershell
az ad app update --id $APP_ID --web-redirect-uris `
  "https://$SWA_HOSTNAME/.auth/login/aad/callback" `
  "https://app.bluecollarcoach.us/.auth/login/aad/callback"
```

## Step 9 — Smoke test

1. Visit `https://<your-swa-hostname>/` (or the custom domain).
2. You're redirected to an Entra login (because every page except `/api/profile` requires auth).
3. Sign in with a Blue Collar Coach account. You land on the role picker (index).
4. Top-right of every page shows a green dot + your name. Sign-out link works.
5. Open the **Scheduler** — drag a job. Refresh the page on a *different device* signed in as a different user — same job is there. Cosmos sync confirmed.
6. Open `/admin.html` as an `administrator`. Edit an emergency rate. Open `/rates.html` — the new rate is live.
7. Open `/admin.html` as a non-admin — you get the **403** page.

## How the auth + sync works (one-liners)

* `staticwebapp.config.json` declares `azureActiveDirectory` as the identity provider. The runtime handles the OAuth dance at `/.auth/login/aad`; there is **no auth code in the app**.
* `bcc-api.js` (included on every page) calls `/.auth/me` to detect the signed-in principal, then pulls every `bcc-*` document from `/api/data` and writes them to `localStorage`. The page code keeps using `localStorage` exactly as it did in v0.1.
* `bcc-api.js` hooks `Storage.prototype.setItem`, so every write to a `bcc-*` key is debounced and POST-ed to `/api/data`, which upserts it into Cosmos.
* Cosmos partitions on `/tenantId` (set to `blue-collar-coach`). One container, one doc per key per tenant.
* Anonymous users (no Entra account / not signed in / SWA bypassed) get a local-only experience — perfect for offline / preview.

## App settings reference

| Setting | Set by | Purpose |
|---|---|---|
| `COSMOS_ENDPOINT` | Bicep | Cosmos account URL |
| `COSMOS_KEY` | Bicep | Cosmos primary key (rotate via `az cosmosdb keys regenerate`) |
| `COSMOS_DB` | Bicep | Database name (default `bcc-connect`) |
| `COSMOS_CONTAINER` | Bicep | Container name (default `data`) |
| `BCC_TENANT_ID` | Bicep | Logical tenant for doc-scoping (default `blue-collar-coach`) |
| `AZURE_TENANT_ID` | Bicep / inline in `staticwebapp.config.json` | Entra tenant for OIDC |
| `AZURE_CLIENT_ID` | Bicep | Entra app registration ID |
| `AZURE_CLIENT_SECRET` | Bicep | Entra app secret |

To update them later: Portal → Static Web App → **Configuration** → Add / edit / save. Changes take effect on the next request.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Endless redirect on sign-in | `openIdIssuer` in `staticwebapp.config.json` doesn't match the Entra tenant. Double-check the GUID. |
| `AADSTS50011` redirect URI mismatch | The Entra app registration's redirect URI doesn't include your SWA hostname. Step 5 / step 8. |
| `/api/data` returns 401 | The user isn't signed in, or the cookie expired. The client redirects to `/login` automatically. |
| `/api/data` returns 500 | Most likely `COSMOS_KEY` not set on the SWA. Check Portal → Configuration. |
| Cosmos says "free tier already enabled" | One subscription can have only one free Cosmos account. Either use the existing one or pass `-EnableCosmosFreeTier $false`. |
| Pages load but sync chip stays grey | `/.auth/me` returned no principal. Confirm the SWA's identity provider config and the Entra app's permissions in step 3. |

## What's NOT yet done (v0.3 backlog)

* Server-side enforcement of per-user permissions (admin role gates `/admin.html` only; finer-grained permissions are stored but not enforced in the API).
* Photos still encoded as base64 in Cosmos docs — fine for tens of photos per job; for hundreds, move to Blob Storage with SAS-signed URLs.
* Role-claim Azure Function that auto-maps Entra group membership to SWA roles.
* Per-user data partitioning (currently the whole company shares one tenant doc set).
* Application Insights wiring for production telemetry.

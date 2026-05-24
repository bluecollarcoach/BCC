# Vercel + Neon Postgres setup

This replaces the original Azure App Service + Azure SQL setup. The Microsoft
Entra ID app registration stays where it is (we still sign in with M365). Azure
Blob Storage also stays — Vercel functions call it for document uploads.

## One-time setup (you do this)

### 1. Neon Postgres
1. Sign up at https://console.neon.tech
2. Create project `bcc-internal`, region **AWS US East (N. Virginia)** (matches Vercel `iad1`)
3. Upgrade to **Launch** plan ($19/mo) → DB stays warm, no auto-suspend
4. Create a second branch called `dev` (Project → Branches → Create)
   - Use the `dev` connection string for local development
   - Use the `main` connection string for Vercel production
5. Copy both connection strings — they look like
   `postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/neondb?sslmode=require`

### 2. GitHub
1. Create a private repo at https://github.com/new (don't initialize with anything)
2. From the project root:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/bcc-internal.git
   git push -u origin main
   ```

### 3. Vercel
1. Sign up at https://vercel.com/signup using the same GitHub account
2. Click **Add New → Project**, pick the `bcc-internal` repo
3. Framework: **Next.js** (auto-detected)
4. Build command: leave default (`npm run build` — `prisma generate && next build`)
5. Root directory: `.`
6. **Don't deploy yet** — set env vars first (see below)

### 4. Vercel environment variables
In Vercel project settings → Environment Variables, add these for Production
(and Preview if you want PR previews to work):

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon main connection string (with `?sslmode=require`) |
| `AUTH_SECRET` | `openssl rand -base64 32` (generate a fresh one) |
| `AUTH_TRUST_HOST` | `true` |
| `AUTH_URL` | `https://bcc-internal.vercel.app` (or your custom domain) |
| `DEV_AUTH_BYPASS` | `false` |
| `AUTH_MICROSOFT_ENTRA_ID` | (copy from `.deploy-secrets.txt` or Entra portal) |
| `AUTH_MICROSOFT_ENTRA_SECRET` | (copy from `.deploy-secrets.txt`) |
| `AUTH_MICROSOFT_ENTRA_TENANT_ID` | `81acb8ef-0b0b-4299-882c-ff07373e8cc7` |
| `AZURE_STORAGE_CONNECTION_STRING` | (copy from current Azure App Service settings) |
| `AZURE_STORAGE_CONTAINER_DOCS` | `bcc-docs` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | (optional; copy from Azure if you want telemetry) |

To pull current secrets from the existing Azure App Service:
```bash
az webapp config appsettings list -g rg-bcc-internal -n bccinternal-web-cmos6krt7roia \
  --query "[?starts_with(name,'AUTH_') || starts_with(name,'AZURE_') || starts_with(name,'APPLICATIONINSIGHTS')].{name:name,value:value}" \
  -o table
```

### 5. Initialize the database schema
After Neon is provisioned and `DATABASE_URL` is in your local `.env`:
```bash
npm install
npx prisma db push        # creates all tables
```

### 6. Update Entra app redirect URIs
The Entra app currently only redirects back to the Azure App Service URL. Add
your Vercel URL too:
```bash
az ad app update --id <app-id-from-AUTH_MICROSOFT_ENTRA_ID> \
  --web-redirect-uris \
    "https://bccinternal-web-cmos6krt7roia.azurewebsites.net/api/auth/callback/microsoft-entra-id" \
    "https://bcc-internal.vercel.app/api/auth/callback/microsoft-entra-id"
```
(Keep both URIs until the Azure version is fully decommissioned.)

### 7. Deploy on Vercel
Click **Deploy** in the Vercel dashboard. First deploy takes ~2 minutes. After
that, every `git push origin main` triggers an auto-deploy that's usually <90s.

## Ongoing dev loop

```bash
# Local dev (uses Neon dev branch):
npm run dev

# Apply schema changes:
npx prisma db push          # pushes to whichever DATABASE_URL is in .env

# Open Prisma Studio:
npm run db:studio
```

To deploy a fix:
```bash
git add -A && git commit -m "fix: ..."
git push
# Vercel auto-deploys in ~90s. Watch progress at vercel.com/<team>/bcc-internal.
```

## Decommission Azure later

Once Vercel is rock-solid and you've signed in there at least once:
```bash
# delete the App Service + plan (saves ~$13/mo)
az resource delete --ids $(az webapp show -g rg-bcc-internal -n bccinternal-web-cmos6krt7roia --query id -o tsv)
az appservice plan delete -g rg-bcc-internal -n bccinternal-plan -y

# delete the SQL server + DB (saves ~$15/mo on serverless meter)
az sql server delete -g rg-bcc-internal -n bccinternal-sql-cmos6krt7roia -y

# KEEP these — they're still in use:
#   - storage account (Azure Blob for documents)
#   - Application Insights (optional)
#   - Entra app registration (sign-in)
```

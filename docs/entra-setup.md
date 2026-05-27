# Microsoft Entra app registration — click by click

Goal: register an Entra (Azure AD) application that lets BCC Connect sign
people in via Microsoft 365 (SWA's built-in `azureActiveDirectory` identity
provider) and pull tenant directory + Graph data.

**Time:** ~10 minutes.
**Prereqs:** you're signed into the Azure portal as a user with Entra
**Application Administrator** or **Global Administrator** role on the
`bluecollarcoach` tenant (tenant GUID
`81acb8ef-0b0b-4299-882c-ff07373e8cc7`).

---

## 1. Create the app registration

1. Go to <https://entra.microsoft.com> → **Identity** → **Applications** →
   **App registrations** → **+ New registration**.
2. Fill in:
   - **Name**: `BCC Connect`
   - **Supported account types**: *Accounts in this organizational directory
     only (bluecollarcoach only — Single tenant)*
   - **Redirect URI**:
     - Platform: **Web**
     - URL: `https://connect.bluecollarcoach.us/.auth/login/aad/callback`
3. Click **Register**.

You'll land on the overview page. **Copy these two values** for the SWA
deployment:

| Label in portal | Goes into SWA app setting |
| --- | --- |
| Application (client) ID | `AZURE_CLIENT_ID` |
| Directory (tenant) ID   | `AZURE_TENANT_ID` |

(You'll add a third — `AZURE_CLIENT_SECRET` — in step 2.)

## 2. Create a client secret

1. Left nav → **Certificates & secrets** → **Client secrets** →
   **+ New client secret**.
2. Description: `BCC Connect (SWA)` · Expires: **24 months** (calendar
   reminder it). 730 days is the Azure cap.
3. Click **Add**.
4. **Copy the Value column immediately** (NOT the Secret ID — the Value).
   It will only ever be shown once. This is your `AZURE_CLIENT_SECRET`.

## 3. Configure API permissions

The same Entra app reg drives BOTH the SWA sign-in (delegated) AND the
`/api/users` tenant-directory pull (application). You need permissions
for both flows:

1. Left nav → **API permissions** → **+ Add a permission** →
   **Microsoft Graph** → **Delegated permissions**. Search and tick:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `User.Read` (usually pre-added)
   - `Calendars.ReadWrite`  *(for sessions.html → Outlook calendar sync)*
   - `Mail.Send`            *(for rates.html → "Send for review")*
2. **+ Add a permission** → **Microsoft Graph** → **Application
   permissions**. Tick:
   - `User.Read.All`  *(for /api/users to enumerate the tenant directory)*
3. Click **Add permissions**.
4. Back on the API permissions list, click **✓ Grant admin consent for
   bluecollarcoach** (top of the table). Status flips to green checkmarks.
   **This step is required** — without admin consent, `/api/users` returns
   502 and Admin → Users & Roles only shows the signed-in user.

## 4. Redirect URIs — add every host you'll use

This is the step that causes "stuck in a login loop on a new device" if
skipped. SWA's OIDC callback lives at `/.auth/login/aad/callback` and the
**exact host** must be in this list — Entra rejects on mismatch.

Left nav → **Authentication** → under **Web · Redirect URIs** click
**Add URI** for each:

- `https://connect.bluecollarcoach.us/.auth/login/aad/callback`
  *(production custom domain — this is the one most often missing after a
  custom-domain bind)*
- `https://ambitious-ocean-0c2aece1e.7.azurestaticapps.net/.auth/login/aad/callback`
  *(default SWA hostname — useful for direct debugging)*

If you have staging slots or PR preview environments, add their URLs too.

Under **Front-channel logout URL** (optional but cleaner):

- `https://connect.bluecollarcoach.us/.auth/logout/aad/callback`

Under **Implicit grant and hybrid flows**: leave both unchecked. SWA uses
the modern code flow.

Under **Advanced settings → Allow public client flows**: leave **No**.

Click **Save**.

## 5. Paste the three values into the SWA

Azure Portal → **Static Web Apps** → your SWA → **Configuration** →
**Application settings**. Add or update:

| Name | Value |
| --- | --- |
| `AZURE_CLIENT_ID`     | Application (client) ID from step 1 |
| `AZURE_CLIENT_SECRET` | Client secret VALUE from step 2 |
| `AZURE_TENANT_ID`     | Directory (tenant) ID from step 1 |

Click **Save**. The SWA recycles app settings within ~30 seconds.

## 6. Verify

1. Open an **InPrivate / Incognito** window on a device that has not signed
   in to BCC before.
2. Visit `https://connect.bluecollarcoach.us`.
3. Microsoft sign-in prompt → enter a `@bluecollarcoach.us` account →
   approve consent → you land on `/index.html` signed in.
4. Admin → Users & Roles should show the full active tenant directory
   (proves application permission for `User.Read.All` was granted).

If you see **AADSTS50011** (redirect URI mismatch), step 4 wasn't done for
the exact host you're testing against. Add the URL, wait ~30s, retry.

---

## CLI alternative (if you've used `az` before)

Steps 1–4 in one shot:

```bash
# 1) Create the app reg with the production redirect URI
az ad app create \
  --display-name "BCC Connect" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris \
    "https://connect.bluecollarcoach.us/.auth/login/aad/callback" \
    "https://ambitious-ocean-0c2aece1e.7.azurestaticapps.net/.auth/login/aad/callback"

# Grab the appId from the output above
APP_ID="<paste-here>"

# 2) Create a 24-month client secret
az ad app credential reset --id $APP_ID --years 2 --display-name "BCC Connect (SWA)"
# (copy the password value — it's only shown here once)

# 3) Add Graph permissions (Delegated: openid/profile/email/offline_access/
#    User.Read/Calendars.ReadWrite/Mail.Send + Application: User.Read.All)
#    Microsoft Graph resource appId is well-known: 00000003-0000-0000-c000-000000000046
GRAPH="00000003-0000-0000-c000-000000000046"

# Each permission needs its GUID. Helpful ones:
#   openid             37f7f235-527c-4136-accd-4a02d197296e (Scope)
#   profile            14dad69e-099b-42c9-810b-d002981feec1 (Scope)
#   email              64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0 (Scope)
#   offline_access     7427e0e9-2fba-42fe-b0c0-848c9e6a8182 (Scope)
#   User.Read          e1fe6dd8-ba31-4d61-89e7-88639da4683d (Scope)
#   Calendars.ReadWrite 1ec239c2-d7c9-4623-a91a-a9775856bb36 (Scope)
#   Mail.Send          e383f46e-2787-4529-855e-0e479a3ffac0 (Scope)
#   User.Read.All      df021288-bdef-4463-88db-98f22de89214 (Role)

az ad app permission add --id $APP_ID --api $GRAPH --api-permissions \
  37f7f235-527c-4136-accd-4a02d197296e=Scope \
  14dad69e-099b-42c9-810b-d002981feec1=Scope \
  64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0=Scope \
  7427e0e9-2fba-42fe-b0c0-848c9e6a8182=Scope \
  e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope \
  1ec239c2-d7c9-4623-a91a-a9775856bb36=Scope \
  e383f46e-2787-4529-855e-0e479a3ffac0=Scope \
  df021288-bdef-4463-88db-98f22de89214=Role

# 4) Grant admin consent (requires Global Admin)
az ad app permission admin-consent --id $APP_ID

# 5) Push the three values into the SWA
az staticwebapp appsettings set \
  --name <swa-name> \
  --resource-group <resource-group> \
  --setting-names \
    AZURE_CLIENT_ID=$APP_ID \
    AZURE_CLIENT_SECRET="<paste from step 2>" \
    AZURE_TENANT_ID="81acb8ef-0b0b-4299-882c-ff07373e8cc7"
```

---

## Adding a new redirect URI later (e.g. another custom domain)

```bash
# Current list:
az ad app show --id $APP_ID --query "web.redirectUris" -o tsv

# Append a new URL (preserve existing ones — this command REPLACES the list):
az ad app update --id $APP_ID --web-redirect-uris \
  "https://connect.bluecollarcoach.us/.auth/login/aad/callback" \
  "https://ambitious-ocean-0c2aece1e.7.azurestaticapps.net/.auth/login/aad/callback" \
  "https://NEW-HOST.example.com/.auth/login/aad/callback"
```

Wait ~30 seconds for Entra to propagate, then retry sign-in.

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Stuck on Microsoft sign-in screen, re-prompts after password | Redirect URI for the current host isn't in the Reply URLs list | Step 4 above; verify with `az ad app show --id $APP_ID --query "web.redirectUris"` |
| **AADSTS50011: redirect URI mismatch** | Same as above, with an explicit error | Add the exact URL from the error to Authentication → Redirect URIs |
| **AADSTS500011: resource principal not found** | Wrong tenant ID, or `common` used instead of the specific GUID | Set `AZURE_TENANT_ID=81acb8ef-0b0b-4299-882c-ff07373e8cc7` |
| **"Need admin approval"** screen | Step 3.4 (admin consent) wasn't done | Sign in as Global Admin, click **Grant admin consent** on the API permissions page |
| `invalid_client` on token exchange | Secret was copied from *Secret ID* column instead of *Value* | Generate a new secret, paste the Value |
| Admin → Users & Roles shows only signed-in user | `User.Read.All` application permission not granted or consent missing | Step 3.2 + 3.4 |
| Sign-in works on one device but loops on another | Browser cookies blocked (privacy mode, Brave shields, ITP) | Try a different browser or disable site cookie protection for `connect.bluecollarcoach.us` |

# Microsoft Entra app registration — click by click

Goal: register an Entra (Azure AD) application that lets BCC Internal sign people in via Microsoft 365 and pull their calendar/mail data via Microsoft Graph.

**Time:** ~10 minutes.
**Prereqs:** you're signed into the Azure portal as a user with Entra **Application Administrator** or **Global Administrator** role on the bluecollarcoach tenant.

---

## 1. Create the app registration

1. Go to <https://entra.microsoft.com> → **Identity** → **Applications** → **App registrations** → **+ New registration**.
2. Fill in:
   - **Name**: `BCC Internal`
   - **Supported account types**: *Accounts in this organizational directory only (bluecollarcoach only - Single tenant)*
   - **Redirect URI**:
     - Platform: **Web**
     - URL: `https://<your-app-name>.azurewebsites.net/api/auth/callback/microsoft-entra-id`
     - (Also add `http://localhost:3000/api/auth/callback/microsoft-entra-id` later for local dev.)
3. Click **Register**.

You'll land on the overview page. **Copy these three values** into a scratch note — you'll paste them into `.env` and the Bicep parameters in a minute:

| Label in portal | Goes into env var |
| --- | --- |
| Application (client) ID | `AUTH_MICROSOFT_ENTRA_ID` |
| Directory (tenant) ID | `AUTH_MICROSOFT_ENTRA_TENANT_ID` |
| (still need to generate a secret — next step) | `AUTH_MICROSOFT_ENTRA_SECRET` |

## 2. Create a client secret

1. Left nav → **Certificates & secrets** → **Client secrets** → **+ New client secret**.
2. Description: `BCC Internal` · Expires: **24 months** (your choice — calendar reminders are your friend).
3. Click **Add**.
4. **Copy the Value column immediately** (not the Secret ID — the Value). It will only be shown once. This is your `AUTH_MICROSOFT_ENTRA_SECRET`.

## 3. Configure API permissions

1. Left nav → **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**.
2. Search and tick:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `User.Read` (usually pre-added)
   - `Calendars.ReadWrite`
   - `Mail.Send`
3. Click **Add permissions**.
4. Back on the API permissions list, click **✓ Grant admin consent for bluecollarcoach** (top of the table). The Status column should flip to green checkmarks for every row.

## 4. Add extra redirect URIs you'll need

Left nav → **Authentication** → under **Web · Redirect URIs**, click **Add URI** and add:

- `http://localhost:3000/api/auth/callback/microsoft-entra-id` (for local dev)
- Any custom domain you'll use later, e.g. `https://internal.bluecollarcoach.us/api/auth/callback/microsoft-entra-id`

Under **Implicit grant and hybrid flows**: leave both unchecked (Auth.js uses the modern code flow).

Under **Advanced settings → Allow public client flows**: leave **No**.

Click **Save**.

## 5. Paste the three values into your deployment

### For local dev (`.env`)

```env
AUTH_MICROSOFT_ENTRA_ID=<Application (client) ID from step 1>
AUTH_MICROSOFT_ENTRA_SECRET=<secret VALUE from step 2>
AUTH_MICROSOFT_ENTRA_TENANT_ID=<Directory (tenant) ID from step 1>
DEV_AUTH_BYPASS=false
```

Restart `npm run dev`. The "Continue with Microsoft 365" button on `/sign-in` should now work.

### For Azure (Bicep parameters)

Edit `infra/azure/main.parameters.json`:

```json
{
  "entraClientId":     { "value": "<Application (client) ID>" },
  "entraClientSecret": { "value": "<secret VALUE>" },
  "entraTenantId":     { "value": "<Directory (tenant) ID>" }
}
```

Then re-run `az deployment group create …` to push the new app settings. (No app re-deploy needed; just App Service config.)

## Verify

- Local: visit <http://localhost:3000/sign-in> → "Continue with Microsoft 365" → consent screen shows the BCC Internal name and the scopes you asked for → you land on `/dashboard` signed in.
- Cloud: same flow at `https://<your-app>.azurewebsites.net/sign-in`.

If you see `AADSTS50011: redirect URI mismatch`, the URL you're testing against isn't in the Authentication → Redirect URIs list. Add it, wait ~30s, retry.

## Common gotchas

- **"Need admin approval"** screen → step 3.4 wasn't done, or your account doesn't have admin rights. Sign in as a Global Admin, repeat the consent step.
- **`invalid_client`** → the secret was copied from the *Secret ID* column instead of *Value*. Generate a new secret and use the Value.
- **`AADSTS500011`** (resource principal not found) → the tenant id is wrong, or you used `common` when the app is single-tenant. Use the specific tenant GUID, not `common`.

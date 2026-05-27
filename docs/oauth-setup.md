# OAuth Setup — Marketing Connectors

Step-by-step dev-portal walkthroughs for the four marketing connectors in
Admin → Integrations:

- [Google Ads](#google-ads)
- [LinkedIn (Marketing API)](#linkedin)
- [Meta (Facebook + Instagram)](#meta)
- [Mailchimp](#mailchimp)

Each connector follows the same flow once the dev app is registered:

1. Paste **Client ID + Client Secret** into the connector card in
   `/admin.html` → Integrations and click **Save**.
2. Click **Connect &lt;Provider&gt;** — you'll be redirected to the
   provider's consent screen.
3. Approve. The provider redirects back to
   `/api/integrations/<channel>/callback` which:
   - Exchanges the auth code for tokens
   - Writes the refresh / long-lived access token to the
     `bcc-integration-<channel>` doc in Cosmos
   - Flips status to **Connected** (green dot)
   - Returns you to `/admin.html?<channel>=connected#integrations`

The shared redirect host is your SWA domain — either the default
`*.azurestaticapps.net` hostname or your custom domain
(`connect.bluecollarcoach.us`). Use whichever you use in production;
the redirect URL must match exactly in the dev portal.

---

## <a id="google-ads"></a>Google Ads

**Authorize:** `https://accounts.google.com/o/oauth2/v2/auth`
**Token:** `https://oauth2.googleapis.com/token`
**Scope:** `https://www.googleapis.com/auth/adwords`

### One-time setup

1. **Apply for a Developer Token.** Required before any production
   API call.
   - Sign in to <https://ads.google.com> with the Google Ads account
     you want to query (manager account works).
   - Tools & Settings → Setup → **API Center**.
   - Fill out the Developer Token application. Approval can take a
     business day or two; you can use the token in **Test** mode
     immediately against a test manager account.
   - Save the token into the connector's **Developer Token** field.

2. **Create an OAuth client.**
   - Go to <https://console.cloud.google.com> → create or pick a
     project.
   - APIs &amp; Services → Library → search **Google Ads API** → Enable.
   - APIs &amp; Services → OAuth consent screen → External (or Internal
     if BCC has a Workspace) → fill out app name, support email,
     developer email. No scopes are required on the consent screen
     itself; we request `adwords` at runtime.
   - APIs &amp; Services → Credentials → **Create credentials** → OAuth
     client ID → **Web application**.
     - **Authorized redirect URIs**: add
       `https://connect.bluecollarcoach.us/api/integrations/google-ads/callback`
       AND your staging SWA URL if you use one.
   - Save. Copy the Client ID + Client Secret.

3. **Paste into BCC.**
   - Admin → Integrations → Google Ads:
     - Developer Token: from step 1
     - OAuth Client ID: from step 2
     - OAuth Client Secret: from step 2
     - Customer ID: your 10-digit Ads account ID (no dashes)
   - Click **Save**, then **Connect Google Ads**.

### What gets stored

`bcc-integration-google-ads.fields.refreshToken` (long-lived, never
expires unless revoked). All API calls use this to mint short-lived
access tokens on demand.

---

## <a id="linkedin"></a>LinkedIn (Marketing API)

**Authorize:** `https://www.linkedin.com/oauth/v2/authorization`
**Token:** `https://www.linkedin.com/oauth/v2/accessToken`
**Default scope:**
`r_organization_social r_ads r_ads_reporting r_emailaddress`

### One-time setup

1. **Request Marketing Developer Platform access.**
   - Sign in at <https://www.linkedin.com/developers/apps> with a user
     who is a Page Admin on the BCC company page.
   - Create app → fill name, LinkedIn page, logo, etc.
   - **Products** tab → request access to:
     - **Sign In with LinkedIn using OpenID Connect** (instant)
     - **Marketing Developer Platform** (review takes 1–7 days; needed
       for `r_ads` + `r_ads_reporting`)
   - While waiting on MDP approval, you can still test with the basic
     scopes — just drop `r_ads r_ads_reporting` from the **OAuth
     scopes** field in BCC.

2. **Configure OAuth.**
   - On the app's **Auth** tab:
     - Add Authorized redirect URLs:
       `https://connect.bluecollarcoach.us/api/integrations/linkedin/callback`
     - Save.
   - Copy the **Client ID** + **Client Secret** from this tab.

3. **Paste into BCC.**
   - Admin → Integrations → LinkedIn:
     - Client ID + Client Secret
     - Organization ID: numeric ID of the BCC LinkedIn page (NOT the
       vanity URL). Find it via
       `linkedin.com/company/<vanity>/admin/` — the URL changes to
       `linkedin.com/organization/<numeric>/admin/`.
     - OAuth scopes: leave the default unless you don't have MDP
       access yet.
   - **Save** → **Connect LinkedIn**.

### What gets stored

- `accessToken` (60-day TTL)
- `refreshToken` (only for MDP-approved apps; rotates on refresh)
- `expiresInSec`

---

## <a id="meta"></a>Meta (Facebook + Instagram)

**Authorize:** `https://www.facebook.com/v18.0/dialog/oauth`
**Token:** `https://graph.facebook.com/v18.0/oauth/access_token`
**Default scope:**
`ads_read,business_management,read_insights,pages_read_engagement`

### One-time setup

1. **Create a Business app.**
   - Go to <https://developers.facebook.com/apps> → **Create App**.
   - App type: **Business**.
   - Tie the app to your Meta Business Manager (or create one).

2. **Enable products.**
   - In the app dashboard:
     - **Facebook Login for Business** → Set up. Configure → Settings:
       - Valid OAuth Redirect URIs:
         `https://connect.bluecollarcoach.us/api/integrations/meta/callback`
       - Allow HTTPS only.
     - (Optional) **Instagram** product → Add to project if you'll
       pull IG insights.
     - (Optional) **Marketing API** → Add for ads_read access.

3. **App Review.**
   - For production access to ads scopes, you must complete App Review:
     - Use Case: Marketing — Ads management.
     - Permissions to request: `ads_read`, `business_management`,
       `read_insights`, `pages_read_engagement`.
   - While in development mode, only users with a role on the app
     (developer, tester, admin) can authenticate. Add BCC team
     accounts under **Roles → Roles** while you wait.

4. **Paste into BCC.**
   - Settings → Basic in the FB app → copy **App ID** + **App
     Secret**.
   - Admin → Integrations → Meta:
     - App ID
     - App Secret
     - Facebook Page ID (optional)
     - Instagram Business ID (optional; find via Instagram Pro account
       → linked FB page → Page ID query)
   - **Save** → **Connect Meta**.

### What gets stored

- `accessToken` (long-lived, 60 days — auto-extends on use)
- `expiresInSec` (initial TTL)

The callback automatically exchanges the short-lived code-derived
token for a 60-day long-lived token via `fb_exchange_token`.

---

## <a id="mailchimp"></a>Mailchimp

**Authorize:** `https://login.mailchimp.com/oauth2/authorize`
**Token:** `https://login.mailchimp.com/oauth2/token`
**Metadata:** `https://login.mailchimp.com/oauth2/metadata`
**Scope:** none (Mailchimp grants account-wide access)

### One-time setup

1. **Register an OAuth app.**
   - Sign in to <https://mailchimp.com>.
   - Profile → Extras → **Registered Apps** → **Register an App**.
   - Fields:
     - App name: `BCC Connect`
     - Company / Org: Blue Collar Coach
     - Description: Internal — sync contacts, campaigns, lists with BCC
       Connect.
     - App website: `https://connect.bluecollarcoach.us`
     - Redirect URI:
       `https://connect.bluecollarcoach.us/api/integrations/mailchimp/callback`
   - Submit. Mailchimp issues a **Client ID** + **Client Secret**
     instantly (no review).

2. **Paste into BCC.**
   - Admin → Integrations → Mailchimp:
     - Client ID + Client Secret
   - **Save** → **Connect Mailchimp**.

### What gets stored

- `accessToken` (long-lived; no expiration)
- `dc` (data center prefix, e.g. `us21`)
- `apiEndpoint` (full host URL — `https://us21.api.mailchimp.com`)
- `accountId`
- `accountName`

### Legacy API-key fallback

If you don't want to register an OAuth app, paste a v3 API key from
**Profile → Extras → API Keys** into the **API Key (legacy)** field
and set the **Server Prefix** (last segment of the API key,
e.g. `us21`). The connector code falls back to this when
`accessToken` is empty.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `?<channel>=error&detail=missing+code` after auth | User cancelled on provider screen | Click Connect again; approve when prompted |
| `?<channel>=error&detail=...token+exchange+...502` | Wrong Client Secret or redirect URI mismatch | Verify Client Secret + the exact redirect URI in the dev portal |
| `Set <channel> clientId + clientSecret in Admin first` | Connect clicked before Save | Paste credentials → Save → Connect |
| Google: `did not return a refresh_token` | Re-consent missing | Revoke at <https://myaccount.google.com/permissions> and try again — BCC requests `prompt=consent&access_type=offline` |
| LinkedIn: `r_ads` rejected | Marketing Developer Platform not yet approved | Edit the **OAuth scopes** field to drop `r_ads r_ads_reporting` until MDP approval lands |
| Meta: "App not active" | Still in dev mode | Add the testing user under Roles → Roles, or complete App Review |
| Mailchimp: 401 on metadata | Token was issued to a different account | Disconnect, sign in to the right Mailchimp account, reconnect |

---

## Where the routes live

All four flows are implemented in `api/src/index.js` (Azure Functions
v4 single-file API), modeled on the existing QBO + MS Graph flows:

| Provider | Connect | Callback |
|---|---|---|
| Google Ads | `/api/integrations/google-ads/connect` | `/api/integrations/google-ads/callback` |
| LinkedIn | `/api/integrations/linkedin/connect` | `/api/integrations/linkedin/callback` |
| Meta | `/api/integrations/meta/connect` | `/api/integrations/meta/callback` |
| Mailchimp | `/api/integrations/mailchimp/connect` | `/api/integrations/mailchimp/callback` |

Tokens are persisted via `saveOAuthTokens(channel, patch)` which
upserts into `bcc-integration-<channel>` in Cosmos with `status:
"connected"` and bumps the integration cache. Every subsequent API
call (TODO: per-provider sync handlers) reads from
`getIntegrationFields(<channel>)`.

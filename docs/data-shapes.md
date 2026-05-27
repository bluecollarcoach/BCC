# BCC Connect — Cosmos document shapes per module

Per the template's Step 3 working order. Every document is a schemaless JSON
blob in the single `data` container, partitioned by `/tenantId =
'blue-collar-coach'`. Field naming is `camelCase`. Every doc has:

```jsonc
{
  "id":        "bcc-<thing>-<cuid>",   // also the localStorage key
  "tenantId":  "blue-collar-coach",
  "docType":   "<thing>",
  "createdAt": "<iso8601>",
  "updatedAt": "<iso8601>",
  // ...module-specific fields below...
}
```

**Additive-only rules.** Per the template ground rules: never rename or
delete a field on a shipped doc. Add new fields freely; legacy docs missing
the new field render with sensible defaults. Migrations, if absolutely
needed, write a new doc + leave the old in place with a `migratedTo` link.

---

## CRM

### `bcc-contact-<cuid>` (shipped — `crm.html`)
```jsonc
{
  "id":         "bcc-contact-c1ab2cdef",
  "tenantId":   "blue-collar-coach",
  "docType":    "contact",
  "firstName":  "Anna",
  "lastName":   "Mitchell",
  "email":      "anna@acmehvac.com",
  "phone":      "+1-320-555-0143",
  "title":      "Owner",
  "company":    "Acme HVAC",          // free-text now; v2 normalizes to companyId
  "companyId":  null,                  // populated when we ship the Companies doc
  "city":       "Saint Cloud",
  "state":      "MN",                  // 2-letter; region inferred
  "country":    "US",
  "stage":      "lead",                // lead|qualified|customer|inactive
  "tags":       ["hvac", "owner-network"],
  "notes":      "Met at the Saint Cloud Chamber breakfast.",
  "ownerId":    "lyle@bluecollarcoach.us",
  "createdAt":  "2026-05-24T22:10:18.000Z",
  "updatedAt":  "2026-05-24T22:10:18.000Z"
}
```

### `bcc-company-<cuid>` (planned)
```jsonc
{
  "id":        "bcc-company-c9z8y7x",
  "tenantId":  "blue-collar-coach",
  "docType":   "company",
  "name":      "Acme HVAC",
  "domain":    "acmehvac.com",
  "industry":  "HVAC",                 // HVAC | Plumbing | Electrical | Roofing | Other
  "size":      "5-20",                 // 1-5 | 5-20 | 20-50 | 50+
  "phone":     "+1-320-555-0100",
  "website":   "https://acmehvac.com",
  "city":      "Saint Cloud",
  "state":     "MN",
  "notes":     "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

### `bcc-deal-<cuid>` (planned)
```jsonc
{
  "id":         "bcc-deal-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "deal",
  "title":      "Q3 group coaching cohort",
  "contactId":  "bcc-contact-...",
  "companyId":  "bcc-company-...",
  "stage":      "discovery|proposal|won|lost",
  "valueCents": 480000,                // $4,800
  "probability":50,
  "ownerId":    "lyle@bluecollarcoach.us",
  "closedAt":   null,                  // iso when stage -> won/lost
  "notes":      "...",
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Sessions / coaching calendar

### `bcc-session-<cuid>`
```jsonc
{
  "id":         "bcc-session-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "session",
  "title":      "1:1 with Anna Mitchell",
  "contactId":  "bcc-contact-...",      // optional
  "coachUpn":   "lyle@bluecollarcoach.us",
  "startAt":    "2026-05-30T14:00:00.000Z",
  "endAt":      "2026-05-30T15:00:00.000Z",
  "allDay":     false,
  "location":   "Zoom",                 // or address
  "prepNotes":  "Review last week's homework on lead-tracking spreadsheet.",
  "postNotes":  "Anna committed to weekly review of pipeline by Friday.",
  "source":     "local",                // local | msgraph
  "msGraphId":  null,                   // populated if synced from Outlook
  "status":     "scheduled",            // scheduled | completed | canceled | no-show
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Engagements (Job Board / pipeline)

### `bcc-engagement-<cuid>`
```jsonc
{
  "id":          "bcc-engagement-...",
  "tenantId":    "blue-collar-coach",
  "docType":     "engagement",
  "title":       "Acme HVAC — quarterly mentorship",
  "contactId":   "bcc-contact-...",
  "companyId":   "bcc-company-...",
  "stage":       "new",                 // new | scheduled | active | waiting | invoiced | done
  "ownerUpn":    "lyle@bluecollarcoach.us",
  "startAt":     "2026-05-15",
  "renewAt":     "2026-08-15",
  "valueCents":  600000,
  "notes":       "...",
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Rate Sheet

### `bcc-rate-sheet-v1` (singleton — admin-editable)
```jsonc
{
  "id":         "bcc-rate-sheet-v1",
  "tenantId":   "blue-collar-coach",
  "docType":    "rate-sheet",
  "packages":   [
    { "name": "1:1 monthly coaching",  "priceCents": 99500,  "cadence": "monthly",  "blurb": "Two 60-min sessions + Voxer access" },
    { "name": "Group cohort",           "priceCents": 49500,  "cadence": "monthly",  "blurb": "Weekly group call + community Slack" },
    { "name": "Strategic intensive",   "priceCents": 350000, "cadence": "one-time", "blurb": "Full-day workshop, custom-built" }
  ],
  "effectiveFrom": "2026-01-01",
  "createdAt": "...", "updatedAt": "..."
}
```

### `bcc-rate-signature-<cuid>` (per-customer e-sign capture)
```jsonc
{
  "id":           "bcc-rate-signature-...",
  "tenantId":     "blue-collar-coach",
  "docType":      "rate-signature",
  "contactId":    "bcc-contact-...",
  "rateSheetVersion": "2026-01-01",     // snapshot of which rates they signed
  "signedAt":     "...",
  "signatureDataUrl": "data:image/png;base64,...",   // canvas blob
  "signedBy":     "Anna Mitchell",
  "ipAddress":    "...",                 // server-filled
  "userAgent":    "..."
}
```

---

## Marketing

### `bcc-campaign-<cuid>`
```jsonc
{
  "id":         "bcc-campaign-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "campaign",
  "name":       "Q2 Owner-Network LinkedIn ads",
  "channel":    "linkedin",             // linkedin | google-ads | meta | mailchimp | wordpress
  "status":     "draft",                // draft | active | paused | completed
  "budgetCents": 200000,
  "spentCents": 0,
  "startAt":    "2026-05-01",
  "endAt":      "2026-05-31",
  "metrics":    { "impressions": 0, "clicks": 0, "leads": 0 },
  "notes":      "...",
  "createdAt": "...", "updatedAt": "..."
}
```

### `bcc-integration-<channel>` (admin-managed connector config)
```jsonc
{
  "id":         "bcc-integration-google-ads",
  "tenantId":   "blue-collar-coach",
  "docType":    "integration",
  "channel":    "google-ads",
  "status":     "disconnected",         // disconnected | connected | error
  "accessToken": "...",                  // encrypted at rest in Cosmos
  "refreshToken":"...",
  "expiresAt":  "...",
  "config":     { "customerId": "..." },
  "updatedAt": "..."
}
```

---

## Bookkeeping

### `bcc-financial-period-<yyyy-mm>`
```jsonc
{
  "id":          "bcc-financial-period-2026-05",
  "tenantId":    "blue-collar-coach",
  "docType":     "financial-period",
  "period":      "2026-05",
  "revenueCents":1250000,
  "expensesCents":420000,
  "netCents":     830000,
  "source":      "qbo",                 // qbo | manual
  "syncedAt":    "...",
  "details":     { ... QBO P&L raw }
}
```

---

## Documents

Documents themselves go to **Azure Blob** (not Cosmos), since they can be
large. Only the metadata lives in Cosmos so we can list/search without
downloading every file. Storage key inside Blob is
`<tenantId>/<folder>/<stamp>-<safeFilename>`.

### `bcc-document-<cuid>`
```jsonc
{
  "id":          "bcc-document-...",
  "tenantId":    "blue-collar-coach",
  "docType":     "document",
  "name":        "Acme-HVAC-coaching-agreement-2026.pdf",
  "folder":      "/contracts",
  "tags":        "hvac, signed",
  "sizeBytes":   234567,
  "mimeType":    "application/pdf",
  "storageKey":  "blue-collar-coach/contracts/20260524T1812Z-acme-hvac....pdf",
  "uploaderUpn": "lyle@bluecollarcoach.us",
  "linkedContactId": "bcc-contact-...",
  "linkedDealId":    null,
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Training

### `bcc-course-<cuid>`
```jsonc
{
  "id":         "bcc-course-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "course",
  "title":      "First 90 Days as an Owner",
  "blurb":      "...",
  "lessons":    [
    { "id": "l1", "title": "Daily numbers you must know", "videoUrl": "...", "durationMin": 18 },
    { "id": "l2", "title": "Setting your hiring bar",      "videoUrl": "...", "durationMin": 22 }
  ],
  "createdAt": "...", "updatedAt": "..."
}
```

### `bcc-enrollment-<userId>-<courseId>`
```jsonc
{
  "id":          "bcc-enrollment-lyle-...",
  "tenantId":    "blue-collar-coach",
  "docType":     "enrollment",
  "userUpn":     "anna@acmehvac.com",
  "courseId":    "bcc-course-...",
  "progress":    { "l1": "complete", "l2": "in-progress" },
  "completedAt": null,
  "createdAt": "..."
}
```

---

## Events

### `bcc-event-<cuid>`
```jsonc
{
  "id":         "bcc-event-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "event",
  "title":      "Saint Cloud Owner Meetup — July 2026",
  "startAt":    "2026-07-15T22:00:00.000Z",
  "endAt":      "2026-07-16T01:00:00.000Z",
  "location":   "Saint Cloud, MN",
  "capacity":   30,
  "registrationOpen": true,
  "bookings":   [
    { "contactId": "bcc-contact-...", "name": "Anna Mitchell", "registeredAt": "..." }
  ],
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Knowledge Base

### `bcc-kb-article-<cuid>`
```jsonc
{
  "id":         "bcc-kb-article-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "kb-article",
  "title":      "How to run your first weekly numbers review",
  "slug":       "weekly-numbers-review",
  "body":       "# Headline\nMarkdown content here...",
  "tags":       ["operations", "playbook"],
  "authorUpn":  "lyle@bluecollarcoach.us",
  "publishedAt":"...",
  "createdAt": "...", "updatedAt": "..."
}
```

---

## My Day / Daily Log

### `bcc-daily-log-<userUpn>-<yyyy-mm-dd>`
```jsonc
{
  "id":         "bcc-daily-log-lyle-2026-05-24",
  "tenantId":   "blue-collar-coach",
  "docType":    "daily-log",
  "userUpn":    "lyle@bluecollarcoach.us",
  "day":        "2026-05-24",
  "clockedInAt":  "2026-05-24T13:00:00.000Z",
  "clockedOutAt": "2026-05-24T22:30:00.000Z",
  "sessionsTouched": ["bcc-session-...", "bcc-session-..."],
  "wins":      "Closed Acme HVAC on the quarterly retainer.",
  "blockers":  "",
  "tomorrow":  "Prep deck for Owner Meetup.",
  "createdAt": "...", "updatedAt": "..."
}
```

---

## Activity log / Audit trail

Two doc types co-exist here, both queried together by `activity.html`:

### `bcc-audit-<cuid>` (intentional user actions)
```jsonc
{
  "id":         "bcc-audit-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "audit",
  "action":     "contact-create",       // allow-listed action type, server-validated
  "userDetails":"lyle@bluecollarcoach.us",
  "path":       "/crm.html",
  "key":        "bcc-contact-...",
  "meta":       { ... arbitrary },
  "ip":         "...",                  // server-filled
  "userAgent":  "...",                  // server-filled
  "_ts":        ...                     // Cosmos timestamp
}
```

### `bcc-access-<cuid>` (every API hit; written by `withAccessLog` wrapper)
```jsonc
{
  "id":         "bcc-access-...",
  "tenantId":   "blue-collar-coach",
  "docType":    "access",
  "method":     "PUT",
  "path":       "/api/data/bcc-contact-...",
  "status":     200,
  "ms":         42,
  "userDetails":"lyle@bluecollarcoach.us",
  "ip":         "...",
  "userAgent":  "...",
  "_ts":        ...
}
```

---

## Admin config (singleton)

### `bcc-admin-config-v1`
```jsonc
{
  "id":        "bcc-admin-config-v1",
  "tenantId":  "blue-collar-coach",
  "docType":   "admin-config",
  "users":     [
    {
      "upn":         "lyle@bluecollarcoach.us",
      "displayName": "Lyle",
      "role":        "admin",        // owner | admin | member
      "status":      "active",       // active | inactive
      "landingPage": "myday.html",   // optional; if set, sign-in lands here instead of /index.html
      "appPermissions": {            // optional per-app override on top of role
        // Keys: home, myday, sessions, crm, jobs, scheduler, marketing,
        //       bookkeeping, documents, rates, chat, training, events, kb, admin
        // Values: 'admin' | 'edit' | 'view' | 'none'
        // Only entries that DIFFER from the role default are stored to keep
        // the doc small (admin default = 'admin' everywhere; member default
        // = 'edit' everywhere except admin which is 'none').
        "bookkeeping": "none",
        "rates":       "view"
      }
    }
  ],
  "auditPassword": "bcc-audit-2026",     // gates activity.html; rotate via admin UI
  "company": {
    "legalName":  "Blue Collar Coach",
    "phone":      "(320) 635-6973",
    "address":    "",
    "tagline":    "Coaching for blue-collar business owners"
  },
  "updatedAt": "..."
}
```

---

## Notes on the localStorage key naming

The Cosmos doc `id` and the browser `localStorage` key are the same string,
so the bcc-api.js `Storage.setItem` hook can map one to the other without a
lookup. Always prefix with `bcc-` so the hook knows what to sync (any
non-prefixed key stays browser-local).

For docs that are 1:1 per user (daily logs) or per period (financial
period), use a deterministic ID with the user/period embedded so we can read
by key without first listing.

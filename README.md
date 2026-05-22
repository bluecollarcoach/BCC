# BCC Internal

Internal operations workspace for the Blue Collar Coach team. Forked from `BCC Connect` (the customer-facing app), re-themed for internal use, and stripped of public marketing surfaces.

## What's different from BCC Connect

| | BCC Connect (customer-facing) | **BCC Internal (this app)** |
| --- | --- | --- |
| Theme | Dark surfaces throughout, gold accent, Georgia serif | Dark chrome (sidebar/topbar) + light content cards, amber accent, Inter typography |
| Landing | Marketing landing at `/` | `/` redirects to `/sign-in` or `/dashboard` |
| Audience | Trade business customers | BCC team only — coaches, staff, ops |
| Robots | Indexable | `noindex, nofollow` (metadata) |
| Auth | Email / Entra | Same |

Everything else (CRM, calendar, chat, time tracking, marketing, bookkeeping, documents, training, events, admin, audit, integrations, Azure infra) is identical to BCC Connect — see `../BCC/README.md` for the full module breakdown and architecture docs.

## Quick start

```powershell
cd C:\Users\Apric\Downloads\BCC-Internal
npm install
Copy-Item .env.example .env
npm run db:push
npm run db:seed
npm run dev
```

Open <http://localhost:3000> → redirects to `/sign-in` → sign in with `owner@bluecollarcoach.us` (dev bypass).

## Design system

The visual system is built on Tailwind tokens that auto-flip with the theme. Key changes from BCC Connect:

- **`bg-chrome` / `text-chrome-foreground`** — dark navigation surfaces (sidebar, topbar, sign-in backdrop)
- **`bg-card` / `text-card-foreground`** — white content surfaces (light-mode by default)
- **`bg-amber` / `text-amber`** — primary accent (`#c8901c`)
- **`card-accent`** CSS utility class adds the 3px amber stripe at the top of a card. Use sparingly on featured cards / KPIs.
- **`chrome-backdrop`** — full dark gradient background used by sign-in / standalone screens
- Inter is loaded via `next/font` and exposed as `var(--font-inter)` / Tailwind's `font-sans`

`gold-*` Tailwind classes still work — they're aliased to amber for backwards-compat with code copied from BCC Connect.

## Deployment

The Azure infrastructure (Bicep templates, GitHub Actions workflow) is unchanged from BCC Connect. Provision a separate resource group (e.g. `rg-bcc-internal`) and re-run the Bicep template — see `infra/azure/README.md`.

If you're running both apps in the same Azure subscription, give them different `name` parameters so the App Service / SQL / SignalR resources don't collide.

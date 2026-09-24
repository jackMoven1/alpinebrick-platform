# Staging deploy runbook (2026-09-24)

Goal: bring up **staging** on Render: core API, Postgres, storefront, admin
console. Shopify, the apex domain and `www` are untouched. Production is a later,
separate Blueprint instance.

Partner sign-off on the spend: received (Jack, 2026-09-24).

## Who you need, and what for

| Service | Who | What |
|---|---|---|
| **Render** (render.com) | Jack | Account, payment method, connect GitHub repo `jackMoven1/alpinebrick-platform` via Render's GitHub app |
| **Google Cloud Console** | Jack (Google account that will own the OAuth client) | One OAuth 2.0 client for admin sign-in |
| **DNS for alpinebrickexchange.com** | Whoever holds the DNS login: Cloudflare per the architecture doc, **confirm** | Three subdomain CNAMEs. The apex and `www` are **not** touched |
| **GitHub** | Agent, with Jack's OK to push | Create the `staging` branch from `main` |

**Not needed for staging:** Stripe (no code reads a Stripe key yet) and Walmart
(the worker is not provisioned and the sandbox gate is open, see
`2026-09-22-walmart-launch-checklist.md`).

## Steps, in order

### 1. GitHub: `staging` branch
Created from `main` after this PR merges, so it carries the admin-ui service.

### 2. Google OAuth client
Google Cloud Console → APIs & Services:
1. **OAuth consent screen**: User type **External** (Internal only works for a
   Workspace org). App name "AlpineBrick Admin". Leave it in **Testing** and add
   each admin's Google address as a **test user**. This is simpler than
   verification, and the core allowlist is the real gate anyway.
2. **Credentials → Create OAuth client ID → Web application.**
   - Authorized redirect URI:
     `https://api-staging.alpinebrickexchange.com/api/v1/auth/google/callback`
3. Keep the **Client ID** and **Client secret** for step 4. Never paste them into chat
   or Discord.

### 3. Render: create the staging Blueprint instance
Dashboard → **New → Blueprint** → repo `alpinebrick-platform`, **branch
`staging`**. It creates `core-api`, `core-db`, `storefront`, `admin-ui` and the
`core-env` group. Plans: `starter` web and `basic-1gb` Postgres. The static sites
are free.

It will prompt for every `sync: false` value. Staging values:

| Where | Key | Value |
|---|---|---|
| core-env | `ADMIN_CONSOLE_ORIGIN` | `https://admin-staging.alpinebrickexchange.com` |
| core-env | `STOREFRONT_ORIGIN` | `https://staging.alpinebrickexchange.com` |
| core-env | `GOOGLE_CLIENT_ID` | from step 2 |
| core-env | `GOOGLE_REDIRECT_URI` | `https://api-staging.alpinebrickexchange.com/api/v1/auth/google/callback` |
| core-env | `ADMIN_ALLOWED_EMAILS` | comma-separated Google addresses allowed into the console |
| core-env | `ASSET_PUBLIC_BASE_URL` | `https://api-staging.alpinebrickexchange.com/assets` (placeholder, see Known gaps) |
| core-env | `GOOGLE_CLIENT_SECRET` | from step 2, **added by hand** as a secret (not in the Blueprint) |
| storefront | `VITE_API_BASE_URL` | `https://api-staging.alpinebrickexchange.com` |
| admin-ui | `VITE_API_BASE_URL` | `https://api-staging.alpinebrickexchange.com` |

Then, per the Blueprint bootstrap notes:
- Enable **"wait for CI checks"** on each service's auto-deploy.
- **Preview environments:** `render.yaml` sets `previews.generation: automatic`,
  so **every PR spins up billed preview services**. Turn this off in the
  dashboard for now unless you want that spend.

### 4. Custom domains
Render → each service → Settings → **Custom Domains**. Add:
- `core-api` → `api-staging.alpinebrickexchange.com`
- `storefront` → `staging.alpinebrickexchange.com`
- `admin-ui` → `admin-staging.alpinebrickexchange.com`

Render shows a CNAME target (`<service>.onrender.com`) for each. At the DNS
provider, create the three **CNAME** records. On Cloudflare, set them **DNS only
(grey cloud)** until Render shows the certificate issued. After that you can
proxy them with SSL mode **Full (strict)**.

The admin console **must** be on the `alpinebrickexchange.com` subdomain, not
its `.onrender.com` URL. The session cookie crosses from `api-staging` to
`admin-staging`, and browsers that block third-party cookies drop it when the
two sit on unrelated domains.

### 5. Verify
- `https://api-staging.alpinebrickexchange.com/health` → `{"status":"ok"}`
- The core-api deploy log shows `prisma migrate deploy` applying every migration.
- `https://staging.alpinebrickexchange.com` loads. The catalog is **empty**: this is
  a fresh database.
- `https://admin-staging.alpinebrickexchange.com` → Sign in with Google → lands
  back in the console signed in; creating a product succeeds.

## Known gaps (staging goes up with these open)

1. **No product images.** The local storage adapter issues upload URLs under
   `/assets`, and nothing in core receives or serves them. Render's filesystem
   is also wiped on each deploy. Fix: the ADR-0002 CDN/object-storage adapter,
   e.g. Cloudflare R2. That is a build task, plus a decision for Jack on the provider.
2. **Empty database; no `system` actor.** `npm run seed` creates the sentinel
   actor that order placement depends on, but `seed` needs `tsx`, a dev
   dependency absent from the production image. Placing an order on staging may
   fail until a migration creates that actor (see
   `2026-09-20-admin-auth-and-cors-follow-ups.md` §1.1). Seed fixtures must
   never be presented as the real catalogue.
3. **`WALMART_API_BASE` in `core-env` is the production URL.** It is harmless
   while sync is disabled. Override it to the sandbox URL on staging before the
   worker is ever provisioned there.
4. **Settlement migrations are not squashed.** The Walmart checklist suggests
   squashing them before the first deploy, while `channel_settlements` is empty.
   Staging deploying them is fine. Decide before **production**'s first deploy.

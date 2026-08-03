# ImagiBricks Deployment Architecture — Cloudflare → Render

**Date:** 2026-08-03
**Status:** Documented per Jack's direction; execution gated on ADR-0004
formal sign-off (Jack + partner, recurring spend) before any account is
created.
**Audience:** engineers implementing the deploy; Jack for approval.
**Related:** [ADR-0004 Hosting Environment](../adr/0004-hosting-environment.md),
[Engineering Status 2026-08-03](../status/2026-08-03-engineering-status.md),
[Walmart plan](../superpowers/plans/2026-08-03-walmart-marketplace-integration.md).

---

## 1. Topology

```mermaid
flowchart TB
    subgraph internet [Internet]
        customer[Customers]
        stripe[Stripe webhooks]
        walmart[Walmart webhooks]
        github[GitHub repo]
    end

    subgraph cloudflare [Cloudflare — edge layer]
        dns[DNS + TLS Full-strict]
        waf[WAF managed rules + rate limiting]
        cdn[CDN cache — static content]
    end

    subgraph render [Render — PaaS layer]
        storefront[storefront\nstatic site]
        api[core-api\nDocker web service]
        worker[core-worker\nDocker background worker]
        pg[(core-db\nmanaged Postgres)]
    end

    customer --> dns
    stripe --> dns
    walmart --> dns
    dns --> waf --> cdn
    cdn -- "cache HIT (assets)" --> customer
    cdn -- "MISS / bypass (/api, html)" --> storefront
    cdn -- "bypass" --> api
    api --- pg
    worker --- pg
    api -. "enqueue jobs (channel_jobs table)" .- worker
    github -- "auto-deploy after CI passes" --> render
```

Two environments, same shape:

| | Production | Staging |
|---|---|---|
| Storefront | `www.imagibricks.com`* | `staging.imagibricks.com`* |
| API | `api.imagibricks.com`* | `api-staging.imagibricks.com`* |
| Branch tracked | `main` | `staging` |
| Stripe | live mode (Jack-approved keys) | test mode |
| Walmart | production API | sandbox API |
| Postgres | `core-db` (daily backups + PITR) | `core-db-staging` (smallest tier) |

\* Domain names are placeholders until the production domain is registered —
one of the bootstrap steps below.

## 2. The layers

### Cloudflare (edge: TLS, WAF, CDN)

Cloudflare is the DNS host and sits proxied ("orange cloud") in front of
every public hostname. Free tier is sufficient at launch.

- **TLS:** mode **Full (strict)** — Cloudflare terminates client TLS and
  validates Render's origin certificate. No flexible mode, ever (it would
  allow plaintext to origin).
- **WAF:** free-tier managed ruleset on; rate-limiting rule on `/api/*`
  (generous ceiling, e.g. 300 req/min/IP at launch — tune from real
  traffic). **Carve-outs:** `POST /api/v1/stripe/webhooks` and
  `POST /api/v1/channels/walmart/webhooks` get their own higher-threshold
  rules so a burst of legitimate provider retries is never WAF-blocked;
  authenticity is enforced at the app layer (Stripe signature verification,
  Walmart webhook secret), not by IP filtering.
- **CDN / cache rules:**
  - `*/assets/*` (Vite's hashed build output): **Cache Everything**, edge
    TTL 30 days — filenames are content-hashed, so stale is impossible.
  - `/` and `*.html`: standard caching, respect origin headers (short
    TTL/ETag) so releases show up immediately.
  - `api.*` hostname: **Bypass cache** entirely.
- **Security headers** (Cloudflare Transform Rules or storefront config):
  HSTS, `X-Content-Type-Options`, CSP for the storefront.

### Render (PaaS: compute + data)

Four resources per environment, all defined in `render.yaml` (§3):

- **`storefront`** — static site. Render builds the Vite bundle and serves
  it from Render's CDN; Cloudflare caches on top. SPA rewrite rule
  (`/* → /index.html`).
- **`core-api`** — Docker web service from `systems/core/Dockerfile`.
  Health check `/health` (already implemented). Runs DB migrations as a
  **pre-deploy command** (`npx prisma migrate deploy`) so a deploy with a
  failing migration never goes live.
- **`core-worker`** — same Docker image, different start command
  (`node dist/worker.js`): runs the outbox processor + pollers/schedulers
  (Walmart plan Task 13's `startWalmartScheduler`, plus future fulfillment
  jobs). Separating it from the API means webhook latency never competes
  with batch work, and it can be scaled/restarted independently. It has no
  public URL.
- **`core-db`** — managed Postgres, private network only. Daily backups;
  point-in-time recovery on the paid tier. **This is the system of record —
  the backup/restore drill below is mandatory before production launch.**

API and worker communicate only through Postgres (the `channel_jobs` outbox
table) — no queue infrastructure to operate. Private-network DB URL only;
the database is never publicly reachable.

### Secrets

- Render **environment groups** per environment (`core-prod`,
  `core-staging`) hold: `DATABASE_URL` (injected from the database
  resource), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `WALMART_CLIENT_ID/SECRET`, `WALMART_WEBHOOK_SECRET`,
  `WALMART_API_BASE`, `WALMART_SYNC_ENABLED`.
- GitHub Actions holds **no deploy credentials** — Render pulls from GitHub;
  CI only needs its own throwaway Postgres.
- Production keys (Stripe live, Walmart production) are entered only by
  Jack, per the standing approval rule. `.env` files never leave local dev.

## 3. Infrastructure as code — `render.yaml` (Blueprint)

One Blueprint at the repo root defines every Render resource. Two Blueprint
instances are created from it: one synced to `main` (production), one to
`staging` (staging), each bound to its own env group. Names below are the
production instance; the staging instance uses the `-staging` suffix at
creation time. (Render's project/environment grouping keeps the dashboard
tidy; verify exact instance flow during bootstrap — it's a one-time
dashboard task.)

```yaml
# render.yaml — ImagiBricks platform Blueprint
previews:
  generation: automatic   # PR preview environments (API + storefront)

services:
  - type: web
    name: core-api
    runtime: docker
    rootDir: systems/core
    dockerfilePath: ./Dockerfile
    plan: starter
    healthCheckPath: /health
    preDeployCommand: npx prisma migrate deploy
    autoDeploy: true          # + "wait for CI checks" enabled in dashboard
    envVars:
      - fromGroup: core-prod
      - key: DATABASE_URL
        fromDatabase:
          name: core-db
          property: connectionString

  - type: worker
    name: core-worker
    runtime: docker
    rootDir: systems/core
    dockerfilePath: ./Dockerfile
    dockerCommand: node dist/worker.js
    plan: starter
    autoDeploy: true
    envVars:
      - fromGroup: core-prod
      - key: DATABASE_URL
        fromDatabase:
          name: core-db
          property: connectionString

  - type: web
    name: storefront
    runtime: static
    rootDir: systems/storefront/code
    buildCommand: npm ci && npm run build
    staticPublishPath: dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
    envVars:
      - key: VITE_API_BASE_URL
        value: https://api.imagibricks.com   # placeholder domain

databases:
  - name: core-db
    plan: basic-1gb
    ipAllowList: []   # private network only — no external access

envVarGroups:
  - name: core-prod
    envVars:
      - key: WALMART_API_BASE
        value: https://marketplace.walmartapis.com
      - key: WALMART_SYNC_ENABLED
        value: "false"   # flipped to true only at Walmart go-live
      # secret values (Stripe/Walmart keys) are set in the dashboard, never here
```

Notes:
- `node dist/worker.js` is a small entrypoint to add to `systems/core`
  alongside `server.ts`: it calls `startWalmartScheduler()` (and future job
  registrations) without binding an HTTP port. Until it exists, the worker
  service is simply omitted from the first Blueprint sync.
- The stale root `docker-compose.yaml` (pre-redesign topology) is **not** a
  deployment artifact; it gets replaced by a minimal local-dev compose file
  (Postgres only) in the bootstrap PR.

## 4. Deployment automation — GitHub → Render

Flow: **PR → CI green + review → merge → Render deploys automatically.**

1. **CI on every PR and push** (`.github/workflows/ci.yml` — this replaces
   the current workflow, which misses `systems/core` entirely):

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main, staging]

jobs:
  core:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: core_test
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s
          --health-timeout 5s --health-retries 10
    defaults:
      run: { working-directory: systems/core }
    env:
      DATABASE_URL: postgresql://postgres:test@localhost:5433/core_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: systems/core/package-lock.json }
      - run: npm ci
      - run: npx prisma migrate deploy
      - run: npx vitest run

  storefront:
    runs-on: ubuntu-latest
    defaults:
      run: { working-directory: systems/storefront/code }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
```

2. **Render auto-deploy** is set to **"after CI checks pass"** on both
   instances — a red CI blocks the deploy, no extra deploy scripts or
   tokens needed.
3. **Migrations** run in Render's pre-deploy step (`prisma migrate deploy`),
   which runs once per deploy before new instances receive traffic; if the
   migration fails, the old version keeps serving.
4. **PR previews:** Render preview environments spin up an ephemeral API +
   storefront per PR (with a preview database only if we enable it —
   default no, previews point at nothing and are for UI/contract review).
5. **Promotion model:** `staging` branch = staging environment;
   `main` = production. Work merges to `staging` first; promoting to prod
   is a fast-forward PR `staging → main`. Both merges are normal reviewed
   PRs per workspace convention.
6. **Rollback:** Render keeps previous deploys — one-click rollback in the
   dashboard, or `git revert` + merge for the auditable path. Database
   rollbacks are forward-only migrations (standard Prisma practice); PITR
   is the disaster lever, not the routine one.

## 5. Request flows (what happens where)

- **Customer browses:** Cloudflare serves hashed assets from edge cache;
  HTML fetched from Render static origin on short TTL; storefront JS calls
  `api.imagibricks.com` (cache-bypassed, WAF-inspected) → `core-api` →
  Postgres.
- **Checkout:** storefront → `core-api` → Stripe (Stripe-hosted payment
  element keeps card data off our stack entirely → PCI SAQ-A).
- **Stripe webhook:** Stripe → Cloudflare (carve-out rule) → `core-api`
  `/api/v1/stripe/webhooks` → signature verify → order transition.
- **Walmart webhook:** same path shape via
  `/api/v1/channels/walmart/webhooks` (secret header verify) → idempotent
  ingest; pollers on `core-worker` are the guaranteed catch-up path, so a
  dropped webhook delays an order by at most one poll interval.
- **Background sync:** `core-worker` processes `channel_jobs` every 30s
  (inventory/price/ack/ship pushes with backoff → dead-letter), polls
  Walmart orders/returns, reconciles inventory hourly, imports settlement
  daily.

## 6. Observability & operations

- **Logs:** Render's built-in log streams per service; structured JSON
  logging in core is a small follow-up.
- **Alerts at launch:** Render health-check failure notifications +
  Render's deploy-failure emails; a daily check of `channel_jobs` where
  `status = 'dead'` (the operator alert surface) until an admin UI exists.
  Uptime monitoring via a free external pinger on `/health` (e.g.
  UptimeRobot) — optional, zero/near-zero cost.
- **Backups:** managed daily Postgres backups + PITR (paid tier).
  **Mandatory pre-launch drill:** restore a staging backup into a scratch
  database and boot the API against it. An untested backup is not a backup.
- **Cost guardrail:** ADR-0004's estimate (~$45–75/mo) still holds;
  Cloudflare adds $0 at launch. Revisit hosting if spend passes ~$200/mo.

## 7. Bootstrap runbook (ordered, one-time)

Gated steps are marked **[JACK]** (infra/spend/live-services approvals).

1. **[JACK + partner]** Sign off ADR-0004 (Render + recurring spend) — tick
   the approval boxes in the ADR.
2. **[JACK]** Register the production domain; add it to a new Cloudflare
   account (free plan); enable 2FA on both accounts.
3. **[JACK]** Create the Render workspace (2FA/SSO on). Engineers get
   member access; billing stays with Jack.
4. Bootstrap PR to the repo: `render.yaml`, new `ci.yml`, `worker.js`
   entrypoint, minimal local-dev `docker-compose.yaml` (Postgres only),
   `.env.example` refresh. Normal review + merge.
5. Create the **staging** Blueprint instance (branch `staging`), attach
   `core-staging` env group with Stripe **test** + Walmart **sandbox**
   creds; verify: deploy green, `/health` 200, webhook endpoint reachable
   over HTTPS, worker processing a seeded no-op job.
6. Point Stripe test-mode and Walmart sandbox webhooks at staging; run the
   Walmart plan's sandbox E2E gate (plan Task 13 step 6) from staging.
7. Cloudflare config as §2: DNS records (proxied), Full-strict TLS, WAF +
   rate limits + carve-outs, cache rules. Verify cache HIT on assets and
   BYPASS on `/api/*`.
8. Backup/restore drill on staging (§6).
9. **[JACK]** Create the **production** Blueprint instance; **[JACK]**
   enters live Stripe keys (Walmart production keys only at channel
   go-live, with partner sign-off per the spec).
10. Cut over DNS for production hostnames; smoke test; enable uptime
    monitor. Production is live behind Cloudflare from day one.

## 8. Decisions captured / still open

Captured here: Cloudflare fronts everything (TLS Full-strict, WAF, CDN for
static), Render runs compute + data per ADR-0004, GitHub is the sole deploy
trigger via CI-gated auto-deploy, Blueprint `render.yaml` is the infra
source of truth, staging-then-main promotion.

Open: production domain name **[JACK]**; structured logging + error
tracker (e.g. Sentry free tier) — proposed as a follow-up; preview-env
database policy if PR previews start needing data; exact Render
project/environment grouping verified at bootstrap step 5.

# ADR-0004: Hosting Environment for the ImagiBricks Platform

**Status:** **Accepted** — approved by Jack 2026-08-03 (architecture/infra
and recurring-spend sign-off given via Jack, who coordinates partner
approval).
**Date:** 2026-08-03
**Author:** Engineering Lead
**Numbering note:** follows `docs/adr/0001`–`0003` (catalog ADRs) and the
root-level `STOREFRONT-ADR-001-TECH-STACK.md`.

---

## Context

Nothing is deployed. Stripe checkout (Phase 1 revenue loop) and the Walmart
Marketplace integration both require a **stable public HTTPS endpoint** for
inbound webhooks, and the Walmart plan additionally assumes **background job
workers** (outbox runner, pollers). Hosting is therefore on the critical path
for delivery.

What we need to run:
- Dockerized **Node/Express API** (`systems/core`) — the modular monolith.
- **PostgreSQL** (Prisma-managed schema; this is the business's system of
  record — backups are non-negotiable).
- **React storefront** (Vite build — static assets plus a thin server or CDN).
- **Background workers / schedulers** (Walmart outbox + pollers; later
  fulfillment queue jobs).
- **Stable HTTPS endpoints** for Stripe and Walmart webhooks (staging + prod).
- **Two environments**: staging and production, with separate databases and
  separate secrets.
- **Secrets management**: env-var injection from the platform; no secrets in
  code or repo (existing rule).

Constraints:
- Two-founder team, **no dedicated ops**. Anything that needs patching,
  on-call, or hand-rolled backups is a hidden headcount cost.
- Early-stage budget: target **< ~$100/month at launch**.
- Boring technology preferred; everything we build is standard Docker +
  Postgres, so we should preserve portability regardless of choice.

All prices below are **approximate ballparks from published pricing as of my
knowledge, not quotes** — verify current pricing before sign-off.

## Options considered

### Option A — PaaS class: Render (or Railway)

Managed platform: connect the GitHub repo, it builds the Dockerfiles, gives
each service a stable HTTPS URL, runs managed Postgres with automated backups,
supports background workers and cron jobs, and injects secrets via environment
groups. Railway is the closest peer (usage-based billing, same shape).

- **Fit:** covers every requirement directly — web services, workers, cron,
  managed Postgres with point-in-time recovery, per-environment secret
  groups, deploy-on-merge, preview environments for PRs.
- **Ops burden:** near zero. No servers, no TLS management, no backup scripts.
- **Estimated cost at launch (approx.):**
  - Production: API service ~$7–25, worker ~$7, managed Postgres ~$7–20,
    storefront (static site) ~$0.
  - Staging: smallest tiers of the same, ~$15–20.
  - **Total ≈ $40–75/month.** Railway similar (~$5 base + usage, likely
    $30–60/month for the same footprint).
- **Migration path:** everything stays a standard Dockerfile + standard
  Postgres. `pg_dump`/restore moves the data; the only platform-specific
  artifact is a small deploy config. Outgrowing it means moving to Option B
  with days, not months, of work.
- **Risks:** less control over networking/scaling knobs; costs rise faster
  than raw compute at real scale (a problem we would be lucky to have);
  platform dependency for builds/deploys (mitigated by Docker portability).

### Option B — AWS ECS/Fargate + RDS (hyperscaler class)

Containers on Fargate, RDS Postgres, ALB for HTTPS, Secrets Manager,
EventBridge for schedulers.

- **Fit:** covers everything, maximal control and headroom.
- **Ops burden:** significant for a two-founder team — VPC/IAM/ALB/task
  definitions, deploy pipeline, log/metric wiring. Realistically needs
  Terraform to stay sane. This is a part-time ops job we don't have.
- **Estimated cost at launch (approx.):** ALB ~$18–25, Fargate tasks
  ~$25–40, RDS small instance + storage ~$15–30, NAT/misc ~$5–35, times a
  reduced-size staging copy. **Total ≈ $90–160/month**, plus the setup and
  maintenance time.
- **Migration path:** it *is* the destination platform — you migrate *to* it,
  not from it.
- **Risks:** complexity and cost both exceed our stage; slows delivery now
  for scale we don't yet need.

### Option C — Managed VPS + Docker Compose + Caddy (e.g., Hetzner/DigitalOcean)

One or two small VPSes running Docker Compose; Caddy for automatic TLS;
Postgres in a container (or DO Managed Postgres ~$15/month to offload
backups).

- **Fit:** functionally sufficient; cheapest raw compute.
- **Estimated cost at launch (approx.):** **$15–40/month** for two small
  boxes, or ~$30–55 with managed Postgres.
- **Ops burden:** highest. OS patching, Docker upgrades, backup scripts and
  restore drills, monitoring, and incident response are all ours. Self-hosted
  Postgres holding customer orders and payment references is the specific
  thing I don't want a two-founder team hand-backing-up.
- **Migration path:** fully portable (it's just Compose), but every month on
  it costs founder attention.
- **Risks:** a missed backup or unpatched box is an existential data risk for
  the price difference of roughly one dinner a month.

## Vendor analysis (added 2026-08-03, web-verified pricing)

Within the PaaS class (Option A, chosen above), four vendors can run our exact
footprint — Docker API + long-lived worker + managed Postgres + static
storefront, in staging + production. Prices are from published pricing pages /
current third-party surveys as of 2026-08; still approximate, not quotes.
Note our scheduler is **in-process** in the worker (Walmart plan Task 13), so
platform-native cron is not a hard requirement anywhere below.

### Render

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — repo-connected deploys, per-env secret groups, preview environments |
| Cost (our footprint) | Prod: API $7–25 + worker $7 + Postgres $6–19 + static $0. Staging: ~$20. **≈ $45–75/mo** |
| Postgres story | Managed, daily backups; point-in-time recovery on paid instances; standard Postgres (clean `pg_dump` exit) |
| Billing model | Fixed per-service tiers — predictable |
| Team familiarity / boring factor | High — closest to "connect repo, get URL" |

**Pros:** best developer experience of the four; every requirement covered
first-class (workers, cron, static sites free, env groups, previews);
predictable bill. **Cons:** private company (platform risk higher than DO);
compute is pricier than raw VPS at scale.

### DigitalOcean App Platform

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low-medium — same repo-connected model, slightly clunkier DX |
| Cost (our footprint) | Prod: API $5–12 + worker $5 + Managed PG $15 + static $0 (3 free). Staging: ~$15–17 w/ dev-tier DB. **≈ $40–50/mo** |
| Postgres story | Mature managed Postgres ($15/mo, daily backups + PITR, no I/O fees); easy exit to plain Droplets |
| Billing model | Fixed tiers — predictable |
| Team familiarity / boring factor | Highest "boring" score — public company, decade-old managed PG product |

**Pros:** cheapest credible managed-Postgres setup; most conservative vendor
(public company); fixed pricing. **Cons:** weaker preview-environment story;
DX friction slightly higher than Render.

### Railway

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost (our footprint) | $5–20 plan + usage; comparable stacks survey at **~$35–80/mo**, variable |
| Postgres story | Postgres as a usage-billed service on volumes; backup/PITR story weaker than Render/DO |
| Billing model | **Usage-based** — least predictable of the four |
| Team familiarity / boring factor | Medium |

**Ruled out:** usage-based billing variance and the thinner managed-Postgres
backup story are the wrong trade for a system of record holding orders.

### Fly.io

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — flyctl-driven, more knobs (regions, volumes, machines) |
| Cost (our footprint) | Machines are cheap ($2–3 each) but **Managed Postgres starts at ~$38/mo** → **≈ $55–90/mo** with staging |
| Postgres story | Managed PG is newer and priced above our needs; self-managed PG on volumes puts backups back on us |
| Billing model | Usage-based |
| Team familiarity / boring factor | Lower — optimized for edge/multi-region apps, which we are not |

**Ruled out:** the $38/mo Postgres floor erases its cheap-compute advantage at
our scale, and its strengths (multi-region edge) solve problems we don't have.

### Vendor trade-off summary

Render and DO App Platform both fit comfortably. Render wins on developer
experience and preview environments (which directly speed our PR-based
workflow); DO wins on vendor conservatism and a slightly lower bill. The gap
is ~$5–25/month and a modest DX difference — either is defensible. **Render is
the primary recommendation; DigitalOcean App Platform is the named fallback**
if we prefer the more conservative vendor — the deploy artifacts (Dockerfile,
env vars, standard Postgres) are identical either way, so switching between
them is a day's work, not a rewrite.

## Security infrastructure (added 2026-08-03, in response to Jack's question)

- **Edge / gateway layer 1 (native):** Render terminates TLS at a managed
  edge (free auto-renewed certificates, HTTPS redirect, load balancing) with
  Cloudflare-backed DDoS protection included for every service at no cost.
  The worker and Postgres are not publicly exposed (private network); only
  the API and storefront get public URLs.
- **Gateway layer 2 — WAF (not native, cheap to add):** Render has **no
  user-configurable WAF** today (it is an open feature request). The standard
  pattern is putting **Cloudflare in front** (free tier) as the second
  gateway layer: WAF managed rules, rate limiting, bot filtering, and
  full-site CDN. This works identically in front of Render or DigitalOcean,
  so it does not change the vendor choice.
- **CDN (native for the storefront):** Render static sites are served from
  its global CDN. Product images will live in object storage (S3/R2) behind
  a CDN — that is an app-architecture item independent of host. Cloudflare
  in front adds full-site CDN if wanted.
- **OAuth / identity (app-layer everywhere, by design):** no PaaS provides
  end-user OAuth for your application — identity is application
  infrastructure. Our architecture already specifies JWT + sessions and
  OAuth for admin/partner access; that runs unchanged on Render. If we later
  want managed identity (Clerk/Auth0 class), it plugs in at the app layer
  regardless of host. Render itself supports SSO/2FA for our team accounts.
- **Compliance posture:** Render publishes SOC 2 Type 2 / ISO 27001 / GDPR
  compliance. Card data never touches our servers — Stripe-hosted payment
  elements keep us in the minimal PCI SAQ-A scope on any host.

Net: Render + free Cloudflare front = the required 1–2 layer gateway, CDN,
and DDoS posture. Recommendation unchanged.

## Decision (proposed)

**Render** (vendor analysis above; DigitalOcean App Platform is the named
runner-up, Railway/Fly.io ruled out):

- Production: `core` API (web service), one background worker, managed
  Postgres, storefront as a static site.
- Staging: same shape at minimum tiers; separate database and secret group.
- Stripe and Walmart webhooks point at the platform-provided stable HTTPS
  URLs (staging endpoints use Stripe test mode / Walmart sandbox only).
- Secrets live only in the platform's environment groups; least-privilege
  keys per environment; production keys are connected only with Jack's
  explicit approval per our standing rule.

**Estimated total: ~$45–75/month at launch scale (approximate, 2026-08
pricing survey).** Fits the <$100 target with headroom. Concrete launch
footprint: prod API Starter ($7, upgrade to Standard $25 if needed) + worker
($7) + Postgres basic tier ($6–19) + static storefront ($0); staging at
minimum tiers (~$20).

## Consequences

- Delivery unblocked: staging with a public HTTPS endpoint can exist within a
  day of approval, which unblocks Stripe webhook work (build-sequence step 3)
  and the Walmart integration's outbox/webhook assumptions.
- We accept modest platform premium over raw VPS pricing in exchange for
  managed backups, TLS, deploys, and zero ops headcount.
- Everything remains a standard Dockerfile + standard Postgres, so the exit
  to AWS (Option B) stays cheap if scale demands it. Revisit this ADR if
  monthly spend passes ~$200 or we need VPC-class networking.
- The stale root `docker-compose.yaml` (old multi-service topology) will be
  replaced by a minimal compose file for **local dev only**; it is not a
  deployment artifact.

## Approval

- [x] Jack — architecture/infra approval (2026-08-03)
- [x] Jack + partner — external recurring spend sign-off (2026-08-03, via Jack)

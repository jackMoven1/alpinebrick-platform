# ADR-0004: Hosting Environment for the ImagiBricks Platform

**Status:** Proposed — awaiting Jack's approval. *This involves recurring
external spend, which requires Jack + partner sign-off before any account is
created or card attached.*
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

## Decision (proposed)

**Option A — Render** (Railway acceptable if we prefer usage-based billing;
same architecture either way):

- Production: `core` API (web service), one background worker, managed
  Postgres, storefront as a static site.
- Staging: same shape at minimum tiers; separate database and secret group.
- Stripe and Walmart webhooks point at the platform-provided stable HTTPS
  URLs (staging endpoints use Stripe test mode / Walmart sandbox only).
- Secrets live only in the platform's environment groups; least-privilege
  keys per environment; production keys are connected only with Jack's
  explicit approval per our standing rule.

**Estimated total: ~$40–75/month at launch scale (approximate).** Fits the
<$100 target with headroom.

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

- [ ] Jack — architecture/infra approval
- [ ] Jack + partner — external recurring spend sign-off

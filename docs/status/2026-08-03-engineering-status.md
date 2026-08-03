# Engineering Status — 2026-08-03

**Author:** Engineering Lead
**Branch surveyed:** `design/platform-redesign` (30 commits ahead of `main`, unmerged)
**Audience:** Jack, CEO

---

## 1. Where we actually are

### systems/core — the real platform (implemented, partial)
`systems/core` is the consolidating backend chosen in the platform redesign
(spec: `docs/superpowers/specs/2026-07-08-imagibrick-platform-redesign-design.md`):
a TypeScript modular monolith — Express 4, Prisma 5 + PostgreSQL, Vitest 2,
integer-cents money, append-only audit log.

**Implemented (Plan 1, "Phase 1 Foundation"):**
- Canonical Prisma schema: `Product` (with `product_type` / `release_type`),
  `Variant`, `Inventory`, `Actor`, `AuditLog`; two committed migrations
  including FK indexes.
- Seed covering both product lines (own-designed + resale) with inventory.
- Read-only catalog API at `/api/v1/catalog` (list, detail, availability),
  scoped to published products, hardened pagination.
- `recordAudit` helper; every mutation path is designed to write audit rows.
- Test suite (health, schema, seed, audit, catalog) running against a **real
  Postgres** container (`imagibrick-core-db`, port 5433). Tests were green as
  of the last commits; I could not re-run today because Docker isn't running
  on this machine right now — not a code problem, just an environment note.

**Written but NOT implemented:**
- **Plan 2 — Orders + Inventory + Tax**
  (`docs/superpowers/plans/2026-07-08-phase2-orders-inventory-tax.md`).
  Adds the order spine: `Order`/`OrderLine`, a `TaxPort` with a flat Michigan
  6% adapter, reserve-on-order / decrement-on-fulfillment stock handling with
  race-safe conditional SQL, and the orders API. This is the prerequisite for
  everything that makes money.
- **Walmart Marketplace integration** (spec + 13-task plan landed today,
  `docs/superpowers/plans/2026-08-03-walmart-marketplace-integration.md`).
  Hard prerequisite: Plan 2 fully executed. Walmart orders enter the same
  order spine as `channel = walmart`, already-paid (marketplace facilitator —
  no Stripe, no tax computation on our side). Adds an outbox job runner,
  webhook endpoint, and pollers — i.e., it assumes background workers and a
  public HTTPS endpoint exist in our hosting environment.

### Stale scaffolds (pre-redesign, mostly dead weight)
- `systems/catalog-service` — **formally superseded** by core's catalog API;
  scheduled for removal at storefront cutover (Plan 5).
- `systems/order-service`, `inventory-service`, `affiliate-service` — each a
  single-file **in-memory mock** (`src/index.js`). No persistence, no real
  logic. They predate the redesign and model the wrong business.
- `docker-compose.yaml` at repo root describes the **old multi-service
  topology** (catalog-service, order-service, etc.) — it does not run core.
  Stale.
- `contracts/` (OpenAPI) and `catalog-admin` / `admin-ui` — the admin console
  Phase A work exists and is useful later (Phase 3 supervision console), but
  it talks to mock stores today.

### Storefront
`systems/storefront/code` is a Vite + React + Tailwind app that renders a
**product-list page only**, proxied to the superseded catalog-service. No
product-detail page, no cart, no checkout, no accounts. New design reference
images landed under `systems/storefront/design/references/` (category page,
product detail) — design direction is starting, implementation hasn't.

### CI — a real gap
`.github/workflows/ci.yml` runs `npm test` across the **npm workspaces list,
which does not include `systems/core`**. So the only code that matters is the
only code CI doesn't test. CI also provisions no Postgres service, which
core's tests require. (Core's exclusion from the workspace was deliberate —
deferred to the Plan 5 cutover — but the CI gap should not wait that long.)

### Branch state
All redesign-era work (core, specs, plans, admin-ui Phase A) lives on
`design/platform-redesign`, **30 commits ahead of `main` and unmerged**. Our
own convention is branch + PR review; this branch has grown into a
long-running trunk. It should be reviewed and merged so `main` reflects
reality and CI protects it.

### Hosting
**No hosting decision exists anywhere in the repo.** Nothing is deployed;
there is no staging environment. Stripe checkout (Phase 1) and the Walmart
integration both require a stable public HTTPS endpoint for webhooks, plus
background workers. This is now on the critical path — see
`docs/adr/0004-hosting-environment.md` (proposed, awaiting Jack's approval).

---

## 2. Recommended build sequence

Sizing is relative t-shirt sizing, not calendar promises. Order matters.

| # | Work | Size | Why this order |
|---|------|------|----------------|
| 0 | **Merge `design/platform-redesign` → `main`** (PR review) and **fix CI** to run core's tests with a Postgres service container | S | Everything after this lands on a protected, tested trunk |
| 1 | **Approve hosting ADR-0004; stand up staging** (app + Postgres + secrets) | S | Unblocks webhooks; lets us deploy every increment from here on |
| 2 | **Execute Plan 2 — orders + inventory + tax** | M | The order spine. Prerequisite for Stripe checkout, the storefront cart, and the Walmart plan. Plan is written and task-decomposed; lowest-risk large chunk we have |
| 3 | **Stripe checkout + payment webhook + Customer + order-level referral attribution** | M–L | Completes the Phase 1 "revenue loop" per the redesign spec. Attribution-at-order-level is a locked day-one requirement — it goes in here, not later. Needs a spec→plan pass first (Plan 3) |
| 4 | **Storefront cutover (Plan 5): point storefront at core; build product detail, cart, checkout UI; delete superseded scaffolds** | M | Storefront and catalog engineers are hired; can partially overlap with #3 once the orders API from #2 is stable |
| 5 | **Production go-live hardening**: refund path basics, monitoring, backups verified, Stripe live keys (Jack approval) | S–M | Gate before real money moves |
| 6 | **Walmart Marketplace integration** (13-task plan) | L | Depends on #2; benefits from #1 (workers + webhook endpoint). Sandbox-only until the order spine has run in production |

Items 3 and 4 can be parallelized across the storefront and catalog engineers
with me on the payments/attribution seam.

## 3. Risks and blockers

1. **Hosting undecided (blocker).** No staging, no webhook endpoint. Decision
   needed this week — ADR-0004 is drafted for Jack's approval. External spend
   requires Jack + partner sign-off.
2. **CI doesn't test core.** Until fixed, a regression in the only real code
   ships silently. Cheap fix; do it at merge time (step 0).
3. **30 unmerged commits on a design branch.** Divergence risk and no CI
   protection on the work that matters.
4. **Tax nexus needs partner sign-off.** Plan 2 ships a flat Michigan 6%
   adapter behind a swappable `TaxPort` — fine as engineering, but where we
   actually have nexus is a compliance decision, not mine. Under/over-
   collection is a liability. Needs Jack + partner before launch.
5. **Walmart plan is large and just landed.** It's well-specced but assumes
   Plan 2's exact deliverables; resist starting it early — rework risk if the
   order spine shifts during implementation.
6. **Stale scaffolds mislead.** The in-memory mock services and old
   docker-compose look real to a new contributor. Delete at cutover (step 4);
   until then, treat `systems/core` as the only backend of record.
7. **Attribution capture is in step 3, not step 2.** Acceptable only because
   nothing sells before step 3 completes. If sequence changes, attribution
   moves with the first sellable checkout — it is non-negotiable at first
   order.

## 4. Bottom line

Foundation is genuinely good: one canonical schema, real Postgres-backed
tests, disciplined money handling, and two well-written plans queued. But no
customer can buy anything yet, and nothing is deployed anywhere. The two
decisions that unblock delivery are (a) hosting (ADR-0004) and (b) green-light
to execute Plan 2. With both, the path to a working revenue loop is plans we
have already written, not open design questions.

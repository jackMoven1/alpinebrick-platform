# ImagiBrick Platform Redesign — Design

**Date:** 2026-07-08
**Status:** Design approved in brainstorming; Phase 1 slice ready for implementation planning.
**Scope of this doc:** A target blueprint for the ImagiBrick commerce platform aligned to the real business, plus a build-ready spec for the first operable slice (Phase 1 — the revenue loop). Later phases are sketched, not fully specced; each gets its own spec → plan cycle.

---

## 1. Context & problem

The existing `engineering/` monorepo is a competent skeleton of a **generic** online store, but very little is production-real and — more importantly — it models the wrong business.

- **One** real database (catalog-service on Postgres), and it is **read-only**.
- Orders, inventory, and affiliate services are **in-memory mocks that vanish on restart**; admin edits are a mock too.
- Storefront is a **product-list page only** — no detail page, cart, checkout, or accounts.
- **No payments, no auth, no fulfillment, no tax/shipping** anywhere.
- The core domain is defined **three inconsistent ways** (catalog-service Postgres schema, admin-ui mock store, OpenAPI contracts) and none of them capture ImagiBrick's actual business.

The redesign is about **boundaries and the domain model**, not rewriting working code. Language/stack are kept.

## 2. Business model (the thing the current blueprint omits)

- **Two product lines, both finished goods:** (1) sets ImagiBrick **designs and produces in-house**, and (2) **specialty / limited-run official LEGO sets resold**. The customer buys a finished boxed product either way.
- **No customer-facing configurator.** "Custom" refers to ImagiBrick's design work, not shopper assembly. Customer experience is conventional retail: browse → buy → ship.
- **Scarcity is first-class.** Limited runs and specialty resales mean finite inventory, sell-outs, and "limited" merchandising — not an infinite catalog.
- **The back office is operated by AI agents.** Catalog management, product setup, order management, and customer management are in-house and intended to be run by AI agents — **supervised-operator now, with the goal of mostly-autonomous.**

## 3. Architecture

**A modular-monolith core + adapter ports (ports-and-adapters), agent-operable by design.**

The core owns and runs in-house: **catalog & product setup, orders, customers.** A small, well-defined outsourced perimeter sits behind swappable ports:

| Port | Adapter now | Adapter later | Data flow |
|---|---|---|---|
| **Payments** | Stripe (hosted Checkout / Payment Intents) | (stays Stripe) | Stripe webhook writes the payment result back onto the order (`pending`→`paid`). |
| **Tax** | nexus-state rate(s) or Stripe Tax | dedicated tax service (Avalara / TaxJar) | Core asks the port to compute sales tax for an order's ship-to + line items; the result lands on the order total. |
| **Inventory** | in-house (Postgres stock + reservations) | third-party inventory source | Core asks the port "available? reserve N?"; caller-agnostic. |
| **Fulfillment / shipping** | manual (paid orders enter a pick-pack-ship queue worked by hand; operator marks shipped + tracking) | carrier/shipper API | A `paid` order pushes into the port; shipment status flows back onto the order. |

**The Order is the spine** — the single source of truth. Payment success writes to it; fulfillment reads from it and writes shipment status back.

**Agent-operability is a primary axis, not a satellite.** Every back-office capability is a **permissioned, audited operation (tool)** invoked the *same way* by humans and agents (exposed as MCP tools + REST). "Supervised vs. autonomous" is only *where the approval gate sits* — a policy dial, not different code. This flips the old plan, which treated MCP as an afterthought and admin-ui as human CRUD.

**Deployment (Hybrid):** one core app + one Postgres to start; genuinely-separate satellites (the MCP/AI connector; possibly the standalone admin/oversight app) stay their own thing. Split a core module into its own service only when real scale/ownership demands it.

**Third-party display integrations** (not core ports): **product reviews are curated from a third-party service and embedded** on product pages — ImagiBrick does not own a reviews data model. **Gift cards are explicitly not in scope.**

**Stack (kept):** React/Vite front-ends, Node backend, Postgres, Stripe.

## 4. Domain model (canonical — one schema, in the core DB)

Replaces the three inconsistent definitions. New/changed vs. today called out.

| Entity | Key fields / changes | Why |
|---|---|---|
| **Product** | + `product_type`: `own_designed` \| `resale`; + `release_type`: `standard` \| `limited_run` \| `specialty`; slug, name, description, images, categories, `status` (draft/published/archived), timestamps, audit actor | Two lines behave differently (margin, sourcing, scarcity, provenance); store must surface "limited" |
| **Variant / SKU** | product_id FK, sku, price, currency, attributes; single-SKU sets stay trivial | Editions/sizes when needed, no ceremony otherwise |
| **Inventory** | stock on hand + reservations, per SKU; finite quantity for limited runs; **behind the inventory port** | Scarcity is a business fact ("last N left" / sold out) |
| **Customer** | **New real entity** (today a bare string): email, name, addresses, comms, **`marketing_consent`** (explicit opt-in flag + timestamp + source), optional auth credential (magic-link or password). *Phase 1: optional account creation at checkout with marketing opt-in, guest still allowed; richer account features in Phase 4.* | Owning a **marketable customer base** from the first sale; agents need a subject to act on; orders need an owner |
| **Order** *(spine)* | customer ref, line items, amounts (subtotal, **discount**, shipping, **tax**, total), lifecycle `pending→paid→fulfilling→shipped→delivered` (+ `canceled`/`refunded`), payment ref, shipping address, **order-level affiliate attribution** (`affiliate_id`, `referral_code`, `commission_*`), actor/audit | Single source of truth for payment + fulfillment; attribution captured at order level from day one (locked decision) |
| **OrderLineItem** | product/variant snapshot, qty, **unit price at purchase**, product_type snapshot | Historical accuracy independent of later catalog edits |
| **Payment** | **New** — Stripe intent/charge ref, status; reconciled by webhook | Real money instead of faked `authorized` |
| **Shipment** | **New** — per order: status, packed_by, shipped_at, carrier, tracking; behind fulfillment port | Manual loop now, ready to automate |
| **Actor** | **New, cross-cutting** — a human or agent identity performing an action | Replaces hardcoded `admin-1`; enables audit + autonomy dial |
| **AuditLog** | **New** — append-only: actor, action, target, before/after, timestamp | Oversight, rollback, the substrate for supervised→autonomous |
| **ApprovalRequest** | **New** — risky actions can require human sign-off | The autonomy dial: gate now, auto-approve by policy later |
| **AffiliatePartner** | **New** — profile, status, Stripe Connect payout account | Partner identity for the referral program |
| **ReferralCode / link** | **New** — code, partner_id, landing target | The shareable marketing hook |
| **ReferralSession** | **New** — captures a referral click/visit (code, visitor, timestamp), attributed to an order at checkout | The capture mechanism behind "attribution from day one" |
| **CommissionRecord** | **New** — per attributed paid order: partner, order, **flat rate**, amount, status | Output of the flat-% commission engine |
| **Payout** | **New** — Stripe **Connect** payout to a partner, batching commission records | Locked decision: partner payouts via Stripe Connect |
| **Discount / PromoCode** | **New** — code, type (% / fixed / free-ship), rules (min-spend, usage/per-customer limits, expiry), status | Marketing/conversion lever; applied as the order's `discount` |
| **Return / RMA** | **New** — order ref, returned items, reason, status `requested→approved→received→refunded`, refund ref (Stripe) | Post-sale ops; drives refunds and restock |

*Tax* is **computed via the tax port**, not a core entity — the tax amount is stored on the Order; nexus config lives with the tax adapter.

**Deferred (YAGNI now):** BOM / parts-level production for own-designed sets — hangs off `own_designed` Product as a future extension; today those are finished SKUs produced manually. **Not doing: gift cards.** Reviews are third-party (embedded, not modeled).

## 5. Build sequence

Each phase ends in something operable and is built on the same substrate (canonical schema + Actor/Audit + tool-based ops), so agent-operability and the autonomy dial are present from day one.

- **Phase 1 — The revenue loop** *(first operable slice; specced in §6).* Browse real sets → checkout with **optional account creation + marketing opt-in** (guest still allowed) → **correct state sales tax (tax adapter)** → Stripe payment → order persists → inventory decrements → manual fulfillment queue. **Also captures referral attribution on every order** (link → session → order), per the locked "attribution from day one" decision.
- **Phase 2 — Affiliate program.** Partner onboarding & management, referral-link generation and click/visit capture, the **flat-% commission engine**, partner dashboards, and **Stripe Connect payouts** — agent-operable + audited like everything else. (Attribution capture already lives in Phase 1.)
- **Phase 3 — Agent-operated catalog, product setup & promotions.** Write/publish path as permissioned audited tools (own vs. resale, limited-run quantities); the **promo-code / discount engine** (types, rules, limits, expiry, redemption); `admin-ui` repurposed as the **supervision console** (approve/audit), not discarded.
- **Phase 4 — Richer customer accounts & service.** Order-history UI, profile/address management, saved details, and agent-operated support — built on the Customer entity introduced in Phase 1, same tool+audit substrate.
- **Phase 5 — Returns / RMA.** Return request → approve → receive → **Stripe refund** + restock; agent-operable + audited. Post-sale ops on the Order spine.
- **Phase 6+ — Turn the dials.** Policy-driven auto-approval (supervised→autonomous); swap in third-party inventory adapter; carrier/shipping adapter; **upgrade the tax adapter to a full tax service**; **third-party reviews display integration**; formalize MCP connector; interaction-tracking.

*(Phase 2 (affiliate) and Phase 3 (catalog/promotions) ordering is swappable — sequence by whether launching the referral channel or agent-run catalog authoring is more urgent when we get there.)*

## 6. First operable slice — Phase 1: The Revenue Loop

**Goal:** a real customer can browse published sets, buy one — as a guest or by **creating an account with a marketing opt-in** — pay via Stripe, and have a persisted order land in a fulfillment queue an operator (human now, agent later) works manually.

### In scope
- **Storefront:** keep product list; add **product detail page**, a **minimal cart**, and **checkout** (email + shipping address) with **optional account creation (magic link or password) and an explicit marketing-consent opt-in** — guest checkout still allowed.
- **Customers & auth:** real Customer entity; optional account at checkout; minimal auth (session) to register / log in; capture `marketing_consent` explicitly (timestamped, with source). Orders link to a Customer when registered, else carry the guest email.
- **State sales tax (tax port):** compute correct tax at checkout via the tax adapter for the ship-to address; start with your **nexus state(s)** (rate table or Stripe Tax), swappable to a full tax service later. The order total math is `subtotal − discount(0 in P1) + shipping(flat) + tax = total`.
- **Referral attribution capture (only):** a referral link/code sets a `ReferralSession`; at checkout the order records an attribution snapshot (`affiliate_id`, `referral_code`, `commission_rate`). Requires a **minimal seeded `AffiliatePartner` + `ReferralCode`** so links resolve. Partner management, the commission engine, dashboards, and payouts are **Phase 2** — Phase 1 just makes sure the attribution data is never lost.
- **Core API modules:** catalog **read** (promote catalog-service; fix the `/api/v1/catalog` path mismatch); **orders** (create + lifecycle, persisted in Postgres); **inventory** (reserve on checkout, commit-decrement on paid, release on failure/expiry) behind the port; **payments** Stripe adapter; **fulfillment** queue.
- **Payments adapter:** Stripe **hosted Checkout Session** (fastest, minimal PCI surface) + **webhook** handler (`checkout.session.completed`) that transitions `pending→paid`, idempotently.
- **Fulfillment:** paid orders appear in an **oversight view** (paid + unfulfilled); operator marks `packed → shipped` with tracking. These are **audited, permissioned tools**.
- **Actor/Audit:** every mutating op records the actor (human/agent id) and appends to the audit log.
- **Schema subset built now:** Product (+type/release_type), Variant, Inventory, Order, OrderLineItem, Payment, Shipment, **Customer (email, name, addresses, `marketing_consent`, optional auth credential)**, Actor, AuditLog, **ReferralSession + minimal AffiliatePartner/ReferralCode (seeded, for attribution)**. Guest orders carry email only; registered orders link to a Customer. Tax is computed via the **tax adapter** (amount stored on the order); the Order carries a `discount` field defaulting to 0 (promo engine is Phase 3).

### Happy-path flow
1. Browse storefront → product detail → add to cart. *(If the visitor arrived via a referral link, its code is captured into a `ReferralSession`.)*
2. Checkout: enter email + shipping address; **choose guest or create an account (magic link / password) with an explicit marketing-consent opt-in** → create/attach the Customer as applicable → **compute state sales tax (tax port) for the ship-to** → create Order (`pending`) with line-item **price snapshots** and total (`subtotal + shipping + tax`) → **reserve** inventory.
3. Create Stripe Checkout Session → redirect → customer pays.
4. Stripe webhook (verified, **idempotent**) → Order `paid`, record Payment, **commit** inventory decrement, **finalize the referral attribution snapshot on the order**, write audit.
5. Order enters fulfillment queue → operator marks `packed → shipped` + tracking → Order `shipped` → audit.
6. Minimal order-confirmation to customer (email — may be stubbed; see open questions).

### Error / edge handling
- **Sold out** (limited runs): insufficient stock at checkout → block, show sold-out.
- **Abandoned/failed payment:** reservation **expires/releases**; order stays `pending` then `canceled`.
- **Webhook retries:** transition is **idempotent** (Stripe retries deliveries).
- **Scarcity race:** reserve/commit are **atomic** so two buyers can't oversell the last unit.

### Components (core modules)
`catalog` (read), `cart`, `orders`, `payments` (Stripe port + webhook), `inventory` (port), `fulfillment` (queue + operator tools), `audit` (actor + append-only log), and an **oversight UI** (fulfillment queue) — reuse the `admin-ui` shell.

### Reuse / migration
- **Keep** catalog-service Postgres + data; fold in as the catalog module's store; fix the path mismatch.
- **Discard** the order/inventory/affiliate in-memory stubs; rebuild on the canonical schema with persistence.
- **Repurpose** the `admin-ui` shell/components for the oversight/fulfillment view.
- Possible reuse: the earlier `ship_est.py` / `price_set.py` utilities as references for flat-rate shipping/pricing math.

### Testing
- **Unit:** price snapshotting, inventory reserve/commit/release, order state machine, webhook idempotency.
- **Unit (add):** tax computation via the adapter for a nexus-state ship-to; order total math (`subtotal + shipping + tax`).
- **Integration / end-to-end:** full buy flow against **Stripe test mode** + Postgres; the **guest** and **create-account (with marketing opt-in)** checkout paths; a **referral-attributed** order (link → session → attribution recorded on the paid order); a **taxed** order (correct sales tax for a nexus-state address); the sold-out path; the abandoned-payment path. (Verifiable end-to-end — a natural Ringer proof task.)

### Out of scope for Phase 1 (deferred)
**Affiliate partner management, the commission engine, dashboards, and Stripe Connect payouts** — Phase 2 (attribution *is* captured in Phase 1); the **promo-code / discount engine** — Phase 3 (the order carries a `discount` field, but no redemption in Phase 1); **returns / RMA** — Phase 5; **richer account features** (order-history UI, profile/address management, saved payment, agent-operated service) — Phase 4; full catalog authoring UI (Phase 3 — seed products directly for now); multi-SKU complexity; third-party inventory; carrier integration; third-party reviews embed; **gift cards (not doing)**; autonomy policies.

## 7. Open questions / decisions to settle in planning

- **Tax provider (decided: tax IS in Phase 1 via an adapter):** which adapter to start with — a **nexus-state rate table** (simplest, if nexus is one/few states) vs. **Stripe Tax** (auto rates + reporting) — and **where do you have nexus?** Partner sign-off / compliance input needed.
- **Shipping cost:** flat-rate for v1 (simplest, honest) vs. weight/zone (we have `ship_est.py` logic already). Recommend flat-rate v1.
- **Checkout style:** hosted Stripe Checkout (recommended, fastest) vs. embedded Payment Element.
- **Order-confirmation email:** minimal transactional email in Phase 1, or stub and defer?
- **Auth method:** magic-link (recommended — no password storage, lowest friction) vs. email + password for account creation.
- **Marketing consent compliance:** store explicit opt-in with timestamp + source and an unsubscribe path; confirm CAN-SPAM (and any GDPR-style) requirements and **partner sign-off on marketing practices**.
- **Cart persistence:** session-based for guest checkout (recommended) vs. persisted.
- **Affiliate attribution model:** last-click vs. first-click, and the attribution window (referral cookie/session lifetime) — settle before Phase 2 payouts turn the captured attribution into real money.
- **Repo shape:** collapse the six commerce services into the modular-monolith core now, or wrap them behind the core incrementally? (Recommend: build the core fresh on the canonical schema, migrate catalog data, retire the stubs.)

## 8. Risks

- **Money + scarcity correctness** is the highest-risk surface: idempotent webhooks and atomic reservations must be right, or you oversell or double-charge. Covered by targeted tests above.
- **Repo migration drift:** partially-built services being retired mid-flight; mitigate by building the core cleanly and cutting over per-module rather than editing the stubs in place.
- **Tax/compliance & nexus** (partner sign-off territory): Phase 1 charges real sales tax, so **where you have nexus and which rates apply must be settled before launch** — an under- or over-collection bug is a compliance liability, not just a math error. The tax adapter isolates this so the provider can be upgraded without touching checkout.
- **Customer data + consent:** a marketable base means storing PII and marketing consent correctly (explicit opt-in, timestamp, source, unsubscribe path). Compliance + partner-sign-off territory — flagged, not solved here.
- **Affiliate attribution correctness:** the attribution policy (last-click, window) and basic fraud controls drive real payouts in Phase 2, so the attribution captured from sale #1 in Phase 1 must be accurate and complete — a silent capture bug becomes a payout dispute later.

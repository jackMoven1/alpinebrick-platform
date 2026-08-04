# Walmart Marketplace API Coverage Analysis

**Date:** 2026-08-03
**Purpose:** verify that every business process Walmart's Marketplace APIs and
seller program require has a comparable or exact match in our platform
(implemented in `systems/core`, or planned in the
[Walmart plan](../superpowers/plans/2026-08-03-walmart-marketplace-integration.md)
/ [spec](../superpowers/specs/2026-08-03-walmart-marketplace-integration-design.md)).
**Verdict up front:** the five core process flows — orders, inventory, price,
returns, settlement — match Walmart's API surface one-for-one in our plan.
There are **2 critical gaps** (both product-data, not process), 3 moderate
gaps, and 4 minor/accepted ones. None invalidate the architecture; all have
concrete dispositions below.

> **Business-status update (2026-08-03, stated by Jack — not independently
> verifiable in repo):** ImagiBricks is **already approved as the sole
> vendor of LEGO collectibles** on Walmart, holds **LEGO branding
> approval**, and Walmart's **GTIN exemption approval is underway**. This
> resolves G9 and the brand-compliance flag outright, and re-scopes G1 —
> see the updated dispositions inline.

---

## Coverage matrix

| # | Walmart requirement (API / program) | Our match | Status |
|---|---|---|---|
| 1 | **Item setup** — Item Mgmt API, spec 5.x feeds (`MP_ITEM`) | Plan Task 8: listing lifecycle + feed submission + status tracking | ✅ Process match; ⚠️ data gaps (G1, G2) |
| 2 | **Product identifiers** — GS1-validated UPC/GTIN required per item | **Nothing** — no GTIN field anywhere; mapper submits `productIdType: SKU`, which Walmart will reject | 🔴 **G1 critical** |
| 3 | **Category attributes** — brand, manufacturer, dimensions, weight + Toys-category attributes | Product model has name/description/images only; mapper fills a minimal Toys block | 🟠 **G2 critical-adjacent** |
| 4 | **Item retire/unpublish** | `retired` listing status exists; no retire API call | 🟡 G5 minor |
| 5 | **Variant grouping** (spec 5.x variant groups) | We list each variant as an independent item | 🟡 G6 minor/deferred |
| 6 | **Price mgmt** — Price API | Plan Task 9: push + per-listing override | ✅ exact match |
| 7 | **Promotions API** | Out of scope (spec: no repricing) | ✅ accepted non-goal |
| 8 | **Inventory** — Inventory API, per SKU + ship node | Plan Task 7: ATS push w/ safety buffer + hourly reconcile; single default ship node | ✅ exact match |
| 9 | **Fulfillment lag time** — item attribute; ship ≤ 2 operational days unless exemption | Prebuilt/used ready-to-ship stock (Jack, 2026-08-03); honest lag time in feed | ✅ **G4 resolved** |
| 9b | **Item condition** — used items need Pre-Owned program approval + condition attributes | New items unaffected; used SKUs gated on program acceptance | 🟠 **G9 business** |
| 10 | **Order retrieval** — Orders API | Plan Task 6: webhook + 15-min poller, idempotent ingest | ✅ exact match |
| 11 | **Acknowledge before ship** (required step) | Plan Task 5/10: auto-ack job on ingest | ✅ exact match |
| 12 | **Ship w/ tracking** (VTR ≥ 99%) | Plan Task 10: `recordChannelShipment` → ship push w/ tracking | ✅ exact match |
| 13 | **Seller cancel** | Plan Task 10: `cancelChannelOrder` → cancel push | ✅ exact match |
| 14 | **Walmart/customer-initiated cancel** (incl. auto-cancel past EDD) | Plan v1: "handled manually" — reservations would stay held until noticed | 🟠 **G3 moderate** |
| 15 | **Delivered status** | Not tracked (Walmart derives from carrier tracking) | ✅ accepted — no action needed |
| 16 | **Returns & refunds** — Returns API | Plan Task 11: idempotent return ingest, `refunded` transition, refund issuance | ✅ match; partial refunds deferred (G7) |
| 17 | **Settlement** — recon reports | Plan Task 12: import + auto-match + review queue | ✅ exact match |
| 18 | **Notifications** — webhook **subscriptions are created/managed via the Notifications API** (get event types, create/update/delete/test subscription) | Plan assumed webhook config exists; no subscription-management calls | 🟡 **G8 minor but required at bootstrap** |
| 19 | **Performance standards** — cancel < 2%, OTD > 95%, VTR ≥ 99%, seller response rate | Supported by flows above + dead-letter monitoring; operationally ours to keep | ✅ operational, noted |
| 20 | **Marketplace facilitator tax** (Walmart collects) | Spec: channel orders skip TaxPort, `walmart_facilitator` provenance | ✅ exact match |
| 21 | **Customer service messaging** (Seller Center) | Manual via Seller Center at launch | ✅ accepted — no API build |
| 22 | **Shipping templates/settings** (Seller Center config) | Operational setup at onboarding | ✅ operational, in runbook |

## Gaps and dispositions

### 🔴 G1 — GS1 UPC/GTINs (critical, blocks listing anything)
Walmart validates product identifiers against the **GS1 database**; every
item needs a legitimately licensed UPC/GTIN — arbitrary or resold barcodes
get blocked. As a maker of custom sets, ImagiBricks owns this problem for
every variant it lists.
**Disposition (engineering):** add `gtin` (nullable, unique) to
`ChannelListing` (or `Variant` if other channels will need it later — recommend
`Variant`); require it in `createListing`; mapper switches to
`productIdType: 'GTIN'`. Small amendment to plan Tasks 1/3/8.
**Refinement (2026-08-03, after Jack clarified the sales model):** this gap
splits by product type (the `ProductType` enum already distinguishes them):
- **`resale` items (previously-retail collectible sets)** — they already
  carry the **manufacturer's UPC/GTIN**; we record it on the variant and
  list by catalog match. **No GS1 licensing needed** for these.
- **`own_designed` sets** — would need GS1 UPCs *unless* covered by a GTIN
  exemption (below).

**Second refinement (same day, per Jack):** a **Walmart GTIN exemption
approval is underway**. Once granted, exempted items list with a
**SKU-type product identifier instead of a UPC** — which is exactly what
the plan's mapper drafts today. Engineering disposition becomes: support
**both** identifier paths — `productIdType: 'GTIN'` when the variant has a
recorded manufacturer UPC (resale match), `productIdType: 'SKU'` for
exempted items — selected per listing. `gtin` stays a nullable Variant
field. GS1 licensing drops off the critical path entirely; revisit only if
the exemption is denied or scoped narrower than expected.
**Remaining action:** confirm the exemption's scope (which
categories/brands it covers) when Walmart grants it, before the first
own-designed listing.

### 🟠 G2 — Required item attributes (brand, manufacturer, dimensions, weight, Toys category fields)
Spec 5.x rejects feeds missing category-required attributes; Toys also
implies compliance attributes (e.g., age grading, small-parts warnings).
**Disposition:** store these in the existing `Variant.attributes` /
`Product.categories` Json (no schema change) under agreed keys; extend
`toItemFeed` to map them; the plan's sandbox E2E gate (Task 13.6) validates
the exact required set empirically. Amend plan Task 3/8 acceptance to include
"feed passes with a fully-attributed real product."
Compliance content itself (age grade, warnings, brand wording for
LEGO-compatible sets) is already flagged in the spec as needing Jack +
partner review.

### 🟠 G3 — Inbound (Walmart-initiated) cancellations
Walmart auto-cancels stale orders and customers can cancel before shipment.
If we don't ingest that, reserved stock stays locked and our cancellation
metrics drift.
**Disposition:** amend plan Task 6's poller — for known (non-terminal)
orders, diff Walmart's line statuses; on `Cancelled`, call the existing
`cancelOrder` (releases reservation, audits) and record a
`ChannelEvent(externalId, 'order_cancelled_inbound')`. ~½ task of work,
reuses existing transitions.

### ✅ G4 — 2-operational-day ship SLA — RESOLVED (2026-08-03, Jack)
Jack confirmed: for Walmart (and ecommerce generally), ImagiBricks sells
**prebuilt or used items ready for sale** — ready-to-ship stock. Standard
lag time applies; no exemptions needed; the safety-buffer inventory design
protects the stocked units. Engineering still sets `fulfillmentLagTime`
honestly in the feed attributes (part of G2 work).
**Roadmap note (explicitly out of current scope):** a future *custom build
competition* feature will introduce pre-sales — orders built to the
competition winner's design and delivered later. That is a
storefront-first preorder/build-to-order flow to be specced when it's
scheduled; it does not change the Walmart v1 design (Walmart does have a
preorder mechanism if the channel ever wants it).

### 🟠 G9 — Collectibles are our stock and trade; Walmart's collectibles/pre-owned programs are gated (updated 2026-08-03)
Jack confirmed the business sells under the **collectibles** category —
previously-sold items are the core inventory. Walmart's reality, verified:

- **Sealed/unopened previously-retail sets** (e.g., retired sets still in
  box): these are **new-condition** items and list through the standard
  path — no program gating. Because they're existing retail products, they
  already carry the **manufacturer's UPC/GTIN**, so listing is
  set-up-by-match against Walmart's catalog. This is likely the launch
  inventory. (Caveat to verify at onboarding: some brands/categories may
  require seller approval to list against.)
- **Opened/used collectible sets**: pre-owned collectible conditions live
  under **Resold at Walmart / the Walmart Collectibles program**, which is
  **invitation-only** (item condition + proof of authenticity required;
  memorabilia needs pre-approval; contact `collectibles@walmart.com` or an
  account manager). Upside once in: collector-specific policies (no-return /
  15-day sealed options) and **0% commission on several collectible
  categories**.
- **Collector Shop supports preorders** — a natural future home for the
  competition pre-sale roadmap item on this channel.

**RESOLVED (2026-08-03, per Jack):** ImagiBricks is **already approved as
the sole vendor of LEGO collectibles** on Walmart and holds **LEGO branding
approval** — the invitation gate and the brand-compliance flag (spec's open
item) are both cleared. The collector-program perks (return-policy options,
0% commission categories) should be confirmed and configured during Seller
Center onboarding.
**Disposition (engineering, unchanged):** condition + authenticity
attributes fold into the G2 attribute work; set-up-by-match for
manufacturer-UPC items is the same MP_ITEM feed with the existing product
identifier — no new architecture.

### 🟡 G5 — Retire item flow
**Disposition:** amend plan Task 8: when a product is archived/unlisted, a
`walmart_retire_item` outbox job calls the retire endpoint and sets the
listing to `retired`. Trivial addition on existing rails.

### 🟡 G6 — Variant grouping
Multiple variants of one product list as independent Walmart items in v1.
Cosmetic (no shared item page), zero data risk.
**Disposition:** defer; revisit when a multi-variant product is actually
listed. Note added to plan Task 8.

### 🟡 G7 — Partial shipments / partial refunds
V1 ships all lines together and issues full-return refunds as Walmart
computes them.
**Disposition:** accepted for launch volume; revisit with real order data.

### 🟡 G8 — Notification subscription management
Webhook subscriptions are **created via API** (event types → create →
test), not just configured in a dashboard.
**Disposition:** add to plan Task 13 bootstrap: a small
`subscriptions.ts` (list event types, create/update subscription pointing at
our webhook URL with the secret header, fire Walmart's test notification)
run once per environment. Also subscribe to the auto-cancel/order events that
feed G3.

## Amendments summary

Plan amendments (small, on existing rails): Task 1 (+`gtin` on Variant),
Task 3 (+GTIN + attributes in `toItemFeed`), Task 6 (+inbound-cancel diff),
Task 8 (+require GTIN, +retire job, +variant-group note), Task 13
(+subscription bootstrap, +fully-attributed feed in the E2E gate).
No architecture change; the anti-corruption layer contains all of it.

Business actions (updated 2026-08-03 — most gates now cleared per Jack):
1. ~~License GS1 UPCs~~ — off the critical path: resale items use
   manufacturer UPCs; **Walmart GTIN exemption underway** covers the rest.
   Remaining: confirm exemption scope when granted (see G1).
2. ~~Stocking policy vs. 2-day SLA~~ — resolved: prebuilt/used ready-to-ship
   stock (see G4).
3. ~~Collectibles program invitation~~ — resolved: **approved as sole vendor
   of LEGO collectibles**; confirm collector return-policy options + 0%
   commission categories at Seller Center onboarding (see G9).
4. ~~Brand review~~ — resolved: **LEGO branding approval received**.

Remaining pre-listing items are now all engineering: the five plan
amendments above, plus the sandbox E2E gate.

## Sources

- https://developer.walmart.com/us-marketplace/docs/item-setup-schema-key-points
- https://sellercloud.com/blog/walmart-item-spec-5/
- https://www.maxmerce.com/blog/walmart-item-spec-50-migration-complete-compliance/
- https://developer.walmart.com/us-marketplace/docs/order-management-api-overview
- https://marketplacelearn.walmart.com/ca/guides/Order%20management/Order%20status/manage-order-status---acknowledge-ship-or-cancel-orders?locale=en-CA
- https://developer.walmart.com/us-marketplace/docs/notifications-overview
- https://developer.walmart.com/us/whats-new/new-order-and-auto-cancelled-order-notifications/
- https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Performance/Seller-performance-standards
- https://marketplacelearn.walmart.com/guides/Policies%20&%20standards/Shipping%20&%20fulfillment/Shipping-and-fulfillment-policy
- https://www.spscommerce.com/community/articles/walmart-marketplace-seller-performance-standards

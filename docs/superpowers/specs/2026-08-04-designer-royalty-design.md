# Designer Attribution & Per-Sale Royalty — Design

**Date:** 2026-08-04
**Status:** Proposed — awaiting Engineering Lead review and Jack's sign-off on the
open questions in §9.
**Author:** Claude (with Jack)
**Depends on:** Plan 2 — Orders + Inventory + Tax
(`../plans/2026-07-08-phase2-orders-inventory-tax.md`). The `Order` /
`OrderLine` spine must exist before royalties can accrue.
**Related:** [Platform redesign](2026-07-08-imagibrick-platform-redesign-design.md)
(defines `AffiliatePartner` / `CommissionRecord` / `Payout`),
[Consolidation & Shopify exit](../../../../../docs/superpowers/plans/2026-08-04-consolidation-and-shopify-exit.md).

---

## 1. Context

AlpineBrick relaunches on two product lines:

| Line | `ProductType` | Sourcing |
|---|---|---|
| Collectibles | `resale` | Prebuilt / previously-sold sets we acquire |
| Custom products | `own_designed` | Designed by a paid designer, **built by a third-party vendor, purchased by us, held as our stock** |

**Custom products are ordinary products.** Same fields, same variants, same
inventory behaviour, same storefront presentation as collectibles. They are
inventory-backed, not build-to-order. There is no quoting, approval, or build-
tracking workflow — the vendor relationship is procurement, not a customer-facing
flow.

The **only** new requirement is that a designer earns **a share of revenue on
every sale** of the product they designed, and we must track it accurately enough
to pay them.

The Shopify "Lego Commission" page (a link to a Google Form) is lead capture for
new design relationships. It is **not** the model for this line and does not
constrain this design.

### Why this is easier than affiliate commission

Affiliate attribution is contested and time-bound: last-click vs first-click,
cookie windows, fraud controls — all flagged as risks in the redesign spec.
**Designer attribution is none of those.** The designer is an intrinsic property
of the product. Every sale of that product owes that designer, deterministically,
with no session state and no attribution policy.

---

## 2. Scope

**In scope:** designer records; product↔designer association with revenue splits;
rate resolution and snapshotting; per-order-line royalty accrual; reversal on
refund/return; feeding the existing payout mechanism.

**Out of scope:** designer recruitment/contracting; the vendor procurement flow
and purchase orders; COGS and margin reporting (see §10); a designer-facing
portal (§9); changes to affiliate commission behaviour.

---

## 3. The decisions this design encodes

Settled by Jack, 2026-08-04:

1. **Rate lives in both places** — a default on the designer, overridable per
   product. Product override wins.
2. **A product may have multiple designers**, via a join table carrying each
   designer's split percentage.
3. **Royalties are clawed back automatically** when an order is refunded or
   returned.

---

## 4. The critical modelling point

The redesign spec defines `CommissionRecord` as *per attributed paid **order***,
with a flat rate applied to the order.

**Designer royalty must attach to the order LINE, not the order.** A cart
containing two collectibles and one designer set owes a royalty on that one line
only. An order-level record cannot express this and will silently mis-pay on
every mixed basket.

Consequently this design introduces a **parallel** `RoyaltyRecord` rather than
extending `CommissionRecord`. The two differ in grain (line vs order),
attribution source (intrinsic vs referral), and lifecycle (reversible vs not).
Forcing them into one polymorphic table would obscure both. They **share** the
`Payout` model, which is genuinely common.

---

## 5. Data model

### 5.1 New: `Designer`

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `name` | string | Display name |
| `email` | string, unique | Contact / payout identity |
| `status` | enum `active \| inactive` | Inactive designers keep earning on existing sales |
| `defaultRateBps` | int | **Basis points**, not a float. 500 = 5.00% |
| `payoutAccountRef` | string, nullable | Stripe Connect account, mirroring `AffiliatePartner` |
| `createdAt` / `updatedAt` | timestamps | |

**Rates are basis points (integer), never floats.** Consistent with the repo's
integer-cents money rule; float percentages reintroduce exactly the rounding
error that rule exists to prevent.

### 5.2 New: `ProductDesigner` (join, with splits)

| Field | Type | Notes |
|---|---|---|
| `productId` | FK → `Product` | |
| `designerId` | FK → `Designer` | |
| `splitBps` | int | This designer's share **of the royalty**, in basis points |
| `rateOverrideBps` | int, nullable | Product-specific rate; overrides the designer default |

- Primary key `(productId, designerId)`; index both sides.
- **`splitBps` across all designers on a product MUST sum to exactly 10000.**
  Enforced in a transaction on every write. A product with a single designer has
  `splitBps = 10000`.
- A product may have **zero** designers — `own_designed` includes in-house designs
  that owe nobody. Absence of rows is valid and means no royalty.

### 5.3 Rate resolution

For a given product, the effective royalty rate is:

```
effectiveRateBps = ProductDesigner.rateOverrideBps ?? Designer.defaultRateBps
```

Resolved **per designer per product**, so a collaboration can mix an overridden
rate for one designer with the default for another.

> **Interpretation to confirm (§9.1):** this design treats `effectiveRateBps` as
> the rate for *that designer's own share*, and `splitBps` as how a
> multi-designer product divides the royalty pool. With one designer at 5% and
> `splitBps = 10000`, the product pays 5%. The alternative reading — a single
> product-level rate that splits between designers — is modelled by giving each
> designer the same `rateOverrideBps`. Worth stating explicitly in the designer
> contracts so the number in the contract matches the number in the database.

### 5.4 New: `RoyaltyRecord`

One row **per (order line, designer)**. A two-designer product on one line
produces two rows.

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `orderLineId` | FK → `OrderLine` | The grain. Indexed |
| `designerId` | FK → `Designer` | Indexed |
| `status` | enum — see §6 | |
| **`rateBpsSnapshot`** | int | Rate **as resolved at time of sale** |
| **`splitBpsSnapshot`** | int | Split **as it stood at time of sale** |
| `basisCents` | int | Revenue the royalty was computed on (§7) |
| `amountCents` | int | The royalty owed |
| `reversedAmountCents` | int, default 0 | Cumulative clawback (§6) |
| `payoutId` | FK → `Payout`, nullable | Set when batched for payment |
| `createdAt` / `updatedAt` | timestamps | |

**Snapshotting is mandatory, not an optimisation.** Rates and splits are
editable. If royalties were computed by looking up the current rate, editing a
designer's `defaultRateBps` would retroactively rewrite what every past sale
earned — including sales already paid out. This mirrors the redesign spec's
existing rule that affiliate attribution is snapshotted onto the order.

Every mutation writes an `AuditLog` row, per the platform-wide rule.

---

## 6. Lifecycle

```
          order paid
              │
              ▼
         [ accrued ] ──── batched into a Payout ───▶ [ paid ]
              │                                          │
     refund / return                            refund / return
              │                                          │
              ▼                                          ▼
        [ reversed ]                            [ clawed_back ]
```

- **`accrued`** — written when the order reaches `paid`. Never on `pending`; an
  unpaid order owes nothing.
- **`paid`** — attached to a `Payout` that has settled.
- **`reversed`** — refunded before payout. Nothing to recover; the record is
  simply not payable.
- **`clawed_back`** — refunded after payout. **A real debt owed back to us.** It
  must be visible in reporting and nettable against the designer's next payout;
  it cannot be silently dropped.

**Partial refunds reverse proportionally.** Refunding 1 of 3 units on a line
reverses one third of that line's royalty, accumulated in
`reversedAmountCents` rather than by flipping `status`. Status changes only when
the line is fully reversed. Net payable is always
`amountCents - reversedAmountCents`.

---

## 7. Computing the amount

```
basisCents  = order line revenue (see the open question in §9.2)
poolCents   = round(basisCents * effectiveRateBps / 10000)
amountCents = largest_remainder_split(poolCents, [splitBps...])
```

**Rounding rule — largest remainder.** Splitting an integer-cent pool by
percentages produces fractional cents. Naive per-designer rounding makes the
parts fail to sum to the whole: three designers splitting 100¢ evenly round to
33¢ each and lose a cent every sale. Allocate floors first, then distribute the
remaining cents one at a time to the largest fractional remainders, ties broken
by `designerId` for determinism.

**Invariant, worth an explicit test:** the sum of `amountCents` across a line's
royalty records equals `poolCents` exactly, for every combination of split
percentages and basis amounts.

---

## 8. Behaviour

- **Order paid** → for each order line, resolve the product's designers; if any,
  snapshot rate and split, compute amounts, write `RoyaltyRecord`s in the same
  transaction that marks the order paid.
- **Order refunded / returned** → reverse proportionally (§6).
- **Product's designers edited** → affects future sales only. Existing records are
  immutable by virtue of their snapshots.
- **Designer set to `inactive`** → stops new product associations; existing
  products keep accruing. Inactive is not a kill switch on earned revenue.
- **Payout** → batches `accrued` records per designer via Stripe Connect, reusing
  the `Payout` model specced for affiliate partners. Net of any outstanding
  `clawed_back` balance.

---

## 9. Open questions — need Jack before implementation

1. **Rate semantics.** Is a designer's rate their *own* share, or the
   *product's* total royalty which is then split? §5.3 assumes the former.
   Whichever is chosen must match the wording in the designer contracts.
2. **Royalty basis.** Gross line revenue, or net of discounts, shipping, and tax?
   Recommendation: **net of line-level discounts, excluding shipping and tax** —
   designers should not earn on sales tax we merely collect and remit, and
   shipping is not product revenue. Needs confirming as a commercial term.
3. **Designer portal.** Self-serve dashboard, or internal reporting only?
   Recommendation: internal only for launch; a portal is a Phase 4-style
   addition and is not on the critical path to selling.
4. **Payout rail.** Stripe Connect, same as affiliate partners, or manual for a
   small number of designers at launch? Connect is already a locked decision for
   partners, so reusing it is cheap — but it means designer onboarding includes
   Connect KYC.
5. **Clawback after payout.** Net against the next payout (assumed here), or
   invoice the designer? Netting is standard; it needs saying in the contract.

---

## 10. Adjacent gap — procurement and margin

We **buy** custom products from a third-party vendor, so every unit has a cost.
Nothing in the schema records purchase orders or unit cost.

The royalty itself is revenue-based and does **not** need COGS. But **margin
does**: vendor cost *and* designer royalty both come out of the sale price, and
without unit cost there is no way to see whether a designer product is
profitable. Not launch-blocking, and deliberately out of scope here — but it
should be settled before pricing decisions are made on this line.

---

## 11. Non-goals

Designer contracting and recruitment; vendor/PO management; COGS and margin
reporting; a designer portal; changes to affiliate attribution or commission;
multi-currency royalties (single-currency USD, consistent with `Variant`).

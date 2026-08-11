# Designer Attribution & Per-Sale Royalty — Design

**Date:** 2026-08-04
**Status:** **Accepted** — all commercial questions approved by Jack 2026-08-04
(§9). Awaiting Engineering Lead review of the technical design. Implementation is
blocked only on Plan 2 delivering the `Order`/`OrderLine` spine.
**Author:** Claude (with Jack)
**Depends on:** Plan 2 — Orders + Inventory + Tax
(`../plans/2026-07-08-phase2-orders-inventory-tax.md`). The `Order` /
`OrderLine` spine must exist before royalties can accrue.
**Related:** [Platform redesign](2026-07-08-imagibrick-platform-redesign-design.md)
(defines `AffiliatePartner` / `CommissionRecord` / `Payout`),
[Consolidation & Shopify exit](../../../../../docs/superpowers/plans/2026-08-04-consolidation-and-shopify-exit.md).
**Amended by:** [Single-creator amendment](2026-08-07-designer-royalty-single-creator-amendment.md)
(Jack, 2026-08-07 — exactly one creator per product, **and that creator is fixed
for the life of the product**, plus five decisions taken the same day on
discounts, rounding, reversal, in-house products and naming). Sections 2, 3,
5.2, 5.3, 5.4, **6**, 7, 8, 9 and 11 below are superseded as set out there.
Where this spec and the amendment disagree, **the amendment wins.**

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

**In scope:** designer records; the single, **nullable, write-once**
product→designer association (`NULL` = no royalty payee — collectibles *and*
in-house `own_designed` products); rate resolution and snapshotting;
per-order-line royalty accrual; reversal on refund/return; feeding the existing
payout mechanism.

**The product→designer association is set at product creation and does not
change (Jack, 2026-08-07).** The designer is consistent for the full life of the
product. This is a property of the model, not an edge case to handle: royalty
logic never has to ask *when* a line was sold relative to a designer change,
because there are no designer changes.

**Out of scope:** designer recruitment/contracting; the vendor procurement flow
and purchase orders; COGS and margin reporting (see §10); a designer-facing
portal (§9); changes to affiliate commission behaviour; **multi-creator products
and any form of split attribution (Jack, 2026-08-07 — a product has exactly one
creator); designer reassignment on an existing product (Jack, 2026-08-07 —
`Product.designerId` is immutable; see §5.2); an internal "house designer"
record for in-house `own_designed` products (Jack, 2026-08-07 — those carry
`designerId NULL` and generate no royalty record at all).**

---

## 3. The decisions this design encodes

Settled by Jack, 2026-08-04:

1. **Rate lives in both places** — a default on the designer, overridable per
   product. Product override wins.
2. **A product has exactly one designer, or none** (Jack, 2026-08-07 —
   superseding the 2026-08-04 multi-designer decision). Modelled as a single
   nullable foreign key on `Product`, not a join table. §5.2.
3. **Royalties are clawed back automatically** when an order is refunded or
   returned.

And the five commercial questions, all approved as recommended:

4. **A designer's rate applies directly to the line basis.** There is no pool
   and nothing to divide — the resolved rate times the basis *is* the amount
   owed. §5.3, §7.
5. **Royalty basis is line revenue net of line-level discounts, excluding
   shipping and tax.** §7.
6. **No designer portal at launch** — internal reporting only.
7. **Payouts via Stripe Connect**, same rail as affiliate partners. §8.
8. **Clawback after payout is netted against the designer's next payout**, not
   invoiced. §6.

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

### 5.2 Changed: `Product` gains a single designer FK

**No join table.** A product has exactly one creator or none (Jack, 2026-08-07),
so the relationship is one-to-one and belongs on `Product` as two nullable
columns:

| Field | Type | Notes |
|---|---|---|
| `designerId` | FK → `Designer`, **nullable**, **immutable once the product exists** | `NULL` = no royalty payee. Set at creation; never updated. Indexed |
| `royaltyRateOverrideBps` | int, nullable, **mutable** | Product-specific rate; overrides `Designer.defaultRateBps`. Meaningless — and must be rejected as non-null — when `designerId` is `NULL`. Editable; edits affect future sales only |

- `NULL designerId` covers **both** collectibles (`ProductType.resale`) and
  in-house `own_designed` products that owe nobody. `productType` already
  distinguishes those two cases, so no additional flag is needed; royalty logic
  only ever asks "is `designerId` set?".
- **In-house `own_designed` products keep `designerId NULL` — decided (Jack,
  2026-08-07).** Do **not** create an internal "AlpineBrick in-house" `Designer`
  at 0 bps to give them a payee. A 0¢ payee produces 0¢ royalty records that
  then flow through payout batching and reporting forever, to answer a question
  `WHERE product_type = 'own_designed' AND designer_id IS NULL` already answers.
  **Do not create a payee that is never paid.** A product with no designer
  produces **no** `RoyaltyRecord`, not a zero-valued one.
- **Do not build a split-attribution table for a relationship that is, by
  decision, one-to-one.** If a future product genuinely has two creators, that
  is a commercial decision for Jack to reopen, not a schema hedge to leave in
  place "just in case".
- Constraint worth having: `CHECK (designer_id IS NOT NULL OR royalty_rate_override_bps IS NULL)`.
  An override with no payee is a data-entry error, not a valid state.

**Invariant — `designerId` is immutable (Jack, 2026-08-07).** Once a product
exists, its `designerId` does not change. *"It's assumed that the designer will
be consistent for the full life of the product."*

- This holds **in every direction**: designer → different designer, `NULL` →
  designer, and designer → `NULL` are all equally not supported. The field is
  written once, at product creation, and read forever after.
- **Designer reassignment is out of scope by decision, not unimplemented.** Do
  not build a reassignment endpoint, a migration path, an effective-dated
  association, or a "designer history" table. There is no history to keep.
- The operational answer to "this designer relationship has ended" is to **stop
  selling the product** — archive or delist it — not to move it to someone else.
  A product's creator is a fact about the product, and facts about a product do
  not change because a commercial relationship did. Note that this composes with
  the accepted spec's existing rule (§8) that an `inactive` designer keeps
  accruing on existing products: inactivating a designer is not a kill switch on
  earned revenue, and it is not a reassignment either.
- **Enforcement is recommended, not merely stated** — an invariant nothing
  enforces quietly stops being true. See §3.6 of the amendment for the
  recommendation and its reasoning; the short version is an application-level
  guard on the product update path, plus a database trigger as a backstop once
  the product has any `RoyaltyRecord`. The `AuditLog` row that every mutation
  already writes is the detector, not the guard.

**One correction is permitted before the product has sold (Jack, 2026-08-11).**
A write to `designerId` while the product has **zero** `RoyaltyRecord`s — a
creation-time typo, or a designer engaged after the product record existed — is
allowed, admin-only and audit-logged. Once a single `RoyaltyRecord` exists the
field is write-once and the guard rejects every write, in all three directions.
The zero-records test is deliberately a fact in the database rather than a
judgement call. See amendment §3.6.

### 5.3 Rate resolution

For a given product, the effective royalty rate is:

```
effectiveRateBps = Product.royaltyRateOverrideBps ?? Designer.defaultRateBps
```

Resolved **per product**. There is at most one designer, so there is exactly one
rate to resolve and nothing to reconcile between payees. If `designerId` is
`NULL`, no rate is resolved and no royalty record is written.

> **Semantics — decided (Jack, 2026-08-04, simplified 2026-08-07).**
> `effectiveRateBps` is applied straight to the line basis. A designer
> contracted at 5% earns 5% of the basis on every line of their product. There
> is no other payee on the line, so there is no share to compute.
>
> **Contract dependency:** the percentage written in a designer's contract must
> be the number stored in `defaultRateBps` / `royaltyRateOverrideBps`. If a contract
> says "5% of the royalty pool" rather than "5% of net sales", the database will
> overpay. Worth a one-line check when each designer is onboarded.

### 5.4 New: `RoyaltyRecord`

**One row per designer order line — at most one.** A line whose product has
`designerId` set produces exactly one royalty record with exactly one payee. A
line whose product has `designerId NULL` produces none. Enforce with a **unique
constraint on `orderLineId`**: the database should make a second payee on a line
impossible, not merely unwritten.

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `orderLineId` | FK → `OrderLine` | The grain. **Unique** — one line, one record, one payee |
| `designerId` | FK → `Designer` | **The payee.** Indexed — payouts batch by it (§8). Not a snapshot: `Product.designerId` is immutable, so this cannot diverge from the product's designer |
| `status` | enum — see §6 | |
| **`rateBpsSnapshot`** | int | Rate **as resolved at time of sale** |
| `basisCents` | int | Revenue the royalty was computed on (§7) |
| `amountCents` | int | The royalty owed |
| `reversedAmountCents` | int, default 0 | Cumulative clawback (§6) |
| `payoutId` | FK → `Payout`, nullable | Set when batched for payment |
| `createdAt` / `updatedAt` | timestamps | |

**Snapshotting the rate is mandatory, not an optimisation.** Rates are editable:
`Designer.defaultRateBps` and `Product.royaltyRateOverrideBps` can both change,
and a rate renegotiated in year two must not restate year one. If royalties were
computed by looking up the current rate, editing a designer's `defaultRateBps`
would retroactively rewrite what every past sale earned — including sales
already paid out. `rateBpsSnapshot` is what makes an accrued record a historical
fact rather than a query against live configuration. This mirrors the redesign spec's
existing rule that affiliate attribution is snapshotted onto the order.

**The designer needs no such protection.** `Product.designerId` is immutable
(§5.2, Jack 2026-08-07), so there is no reassignment for a snapshot to defend
against. `RoyaltyRecord.designerId` is carried for a different reason — it is
the **payee** on a financial record, not a defence against drift. See below.

**Why `RoyaltyRecord.designerId` stays, now that it is not a snapshot.** Because
`Product.designerId` cannot change, the designer on a royalty record is always
derivable by joining `OrderLine → Product`. The column is kept anyway, and
**must not be dropped as redundant**, for three reasons that have nothing to do
with drift:

1. **It is the payee on a financial record.** Payouts batch `accrued` records
   per designer (§8). The payee has to be *on* the row being paid, not two
   joins away through the catalogue.
2. **A ledger row must stand alone.** "Who was paid, how much, on what basis, at
   what rate" should be answerable from the record itself years later, without
   depending on the catalogue still holding the product — or holding it
   unchanged. This is the same instinct as `rateBpsSnapshot` and `basisCents`,
   applied to identity rather than to arithmetic.
3. **Derivability is not the test for money.** A number we can recompute is
   still a number we have to defend to a real person. Recomputation is a
   reconciliation check, not a substitute for recording what we did.

So the field's justification changes — from "the designer might change" to "the
designer is the payee" — but the field itself does not.

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

**Partial refunds reverse by recomputing from the refunded basis — decided
(Jack, 2026-08-07).** A reversal uses the **same formula and the same
snapshotted rate as the accrual**, never a re-resolved current rate:

    refundedBasisCents      = the refunded portion of the line's basis, computed
                              exactly as the accrual basis is (net of the line's
                              allocated discount, excluding shipping and tax)

    cumulativeReversalCents = round_half_up(
                                  cumulativeRefundedBasisCents
                                  * rateBpsSnapshot / 10000 )

    reversedAmountCents     = min(cumulativeReversalCents, amountCents)

Compute the reversal **cumulatively** — against the total basis refunded on the
line so far — and store the result, rather than adding an independently rounded
increment per refund event. Incremental rounding is what makes three successive
one-third refunds fail to net to zero; the cumulative form cannot drift.

**The cap is mandatory.** `reversedAmountCents` is capped at `amountCents`, so a
fully refunded line nets to exactly zero and never below. We do not claw back
more than we accrued.

A goodwill partial refund that is a cash amount rather than a number of units
uses the same formula: `refundedBasisCents` is the refunded amount attributable
to that line's basis, excluding any refunded shipping or tax. Royalty never
reverses on shipping or tax, because it never accrued on them.

Reversals accumulate in `reversedAmountCents` rather than by flipping `status`.
**Status changes only when `reversedAmountCents == amountCents`** — to
`reversed` if the record was never paid out, `clawed_back` if it was (§6
statuses, unchanged). Net payable is always `amountCents - reversedAmountCents`,
and is never negative.

---

## 7. Computing the amount

```
basisCents  = orderLine.lineSubtotalCents - orderLine.discountCents
              (excludes shipping and tax entirely; `discountCents` is the
               line's share of any order-level discount, allocated and stored
               at order creation — Jack, 2026-08-07)

amountCents = round_half_up(basisCents * rateBpsSnapshot / 10000)

where round_half_up(x) rounds a half cent AWAY from zero — decided (Jack,
2026-08-07). Since basisCents and rateBpsSnapshot are both non-negative
integers, implement it in integer arithmetic and keep floats out of it
entirely:

    amountCents = (basisCents * rateBpsSnapshot + 5000) / 10000   // integer div

Do not use the language's default rounding. `Math.round` in JavaScript is
half-up only for positive numbers and is float-based; that it happens to agree
here is a coincidence, not a specification.
```

**There is no allocation step.** The pool concept and `largest_remainder_split`
disappear: with one payee per line, the computed amount *is* the amount owed.

**Basis — decided (Jack, 2026-08-04): line revenue net of line-level discounts,
excluding shipping and tax.** Designers do not earn on sales tax, which we merely
collect and remit to the state, nor on shipping, which is not product revenue.
Discounts reduce the basis because a discounted sale genuinely produced less
revenue.

> **Implementation note — settled (Jack, 2026-08-07), no longer open.** This
> requires the order line to carry a **line-level** discount amount. Checkout
> pro-rates any order-level discount across lines by line subtotal and persists
> `OrderLine.discountCents`; royalty reads the stored value and never re-derives
> it. Plan 2 gained that column accordingly — see amendment §3.1.1. Related
> ruling (Jack, 2026-08-11): a discount also reduces the **taxable** base, which
> is an orders-side concern and does not touch royalty, since royalty excludes
> tax either way.

**Rounding rule — half-up, decided (Jack, 2026-08-07).** There is no allocation,
so there is no largest-remainder step and no tie-break. A single
`round_half_up()` of `basisCents * rateBpsSnapshot / 10000` produces the whole
amount, and a half cent rounds **away from zero**.

Half-up was chosen because it matches the ordinary reading of "5% of net sales"
that a designer's contract will carry: a designer checking our arithmetic by
hand reproduces our number. Half-even's bias-correction argument applies when
parts must sum to a whole, which is precisely the invariant the single-creator
decision removes; floor was rejected because a rule that can only ever underpay
a partner is not one we want to have to explain.

Pin it with a test using half-cent fixtures — e.g. a basis and rate whose
product ends in exactly 5000 — not with the language default.

**Invariants, each worth an explicit test:**

1. A line's product has `designerId` set ⇒ exactly one `RoyaltyRecord` exists
   for that line. `designerId NULL` ⇒ zero records. Never two, and never a
   zero-valued placeholder record for an in-house product.
2. `amountCents == round_half_up(basisCents * rateBpsSnapshot / 10000)` — half-up
   specifically (Jack, 2026-08-07) — for the full range of basis values
   including 0, 1¢, and a fixture whose product lands exactly on a half cent.
3. `reversedAmountCents` never exceeds `amountCents` (§6). Refunding a line in
   several unequal steps leaves `amountCents - reversedAmountCents == 0`
   exactly once the line is fully refunded — never negative, never a residual
   cent.
4. A mixed cart accrues on the designer lines **only** — the collectible lines
   produce no records at all. Test this with an explicit mixed-basket fixture;
   it is the failure mode that costs real money and raises no error.
5. `sum(OrderLine.discountCents) == Order.discountCents` for every order, so the
   basis of every line is reproducible from stored data alone (§3.1). Strictly
   an orders-side invariant, but royalty correctness depends on it, so it is
   worth a test on this side of the boundary too.
6. **`Product.designerId` never changes** (Jack, 2026-08-07). An attempt to
   update it on an existing product is **rejected**, not silently applied — in
   all three directions: to a different designer, from `NULL` to a designer, and
   from a designer to `NULL`. Test the rejection, not just the absence of a
   reassignment endpoint; the guard is the thing that can regress. Corollary
   worth asserting alongside it: for every `RoyaltyRecord`, `designerId` equals
   the `designerId` of its line's product — which under this invariant is true
   forever, and is the cheapest possible reconciliation check.
   *(Pre-sale carve-out, Jack 2026-08-11: a write is permitted while the product
   has zero `RoyaltyRecord`s — test that boundary in both directions, allowed
   before the first accrual and rejected after.)*

---

## 8. Behaviour

- **Order paid** → for each order line, resolve the product's `designerId`; if
  set, snapshot the designer and the resolved rate, compute the amount, and
  write **one** `RoyaltyRecord` in the same transaction that marks the order
  paid. Lines whose product has no designer are skipped silently — that is the
  correct behaviour for every collectible line.
- **Order refunded / returned** → reverse proportionally (§6).
- **Product's rate override edited** → affects future sales only. Existing
  records keep their `rateBpsSnapshot` and are unaffected.
- **Product's designer edited** → **does not happen.** `Product.designerId` is
  immutable (§5.2, Jack 2026-08-07); the update is rejected. There is no
  "re-attribute future sales" behaviour to specify, because there is no
  reassignment.
- **Designer set to `inactive`** → stops new product associations; existing
  products keep accruing. Inactive is not a kill switch on earned revenue.
- **Payout** → batches `accrued` records per designer via Stripe Connect, reusing
  the `Payout` model specced for affiliate partners. Net of any outstanding
  `clawed_back` balance. A designer without a completed Connect account
  (`payoutAccountRef` null) still **accrues** normally — royalties are earned at
  sale, not at payout — but cannot be batched until KYC completes. Accrual must
  never be gated on payout readiness.

---

## 9. Commercial decisions — approved by Jack 2026-08-04, extended 2026-08-07

All five were approved as recommended on 2026-08-04. Row 6 was added
2026-08-07 with the single-creator amendment, likewise as recommended.
Recorded here with their consequences.

| # | Decision | Consequence |
|---|---|---|
| 1 | **A designer's rate applies directly to the line basis** (simplified by the one-creator decision, Jack 2026-08-07) | The contract percentage must equal the stored rate — see the contract dependency in §5.3 |
| 2 | **Basis = line revenue net of line-level discounts, excluding shipping and tax** | Requires **line-level** discount amounts. **Settled (Jack, 2026-08-07):** checkout pro-rates any order-level discount across lines by line subtotal and persists `OrderLine.discountCents`; royalty reads the stored value and never re-derives it. Plan 2's `OrderLine` must gain that column before accrual is implemented — see §3.1 and §3.1.1 of the single-creator amendment |
| 3 | **No designer portal at launch** — internal reporting only | Designers cannot self-serve. Someone has to answer "what did I earn?" manually; budget for that operationally |
| 4 | **Payouts via Stripe Connect**, same rail as affiliate partners | **Designer onboarding now includes Connect KYC.** A designer cannot be paid until they complete it — start onboarding before the first sale, not after |
| 5 | **Clawback after payout nets against the next payout** | A designer with no subsequent sales carries an unrecovered balance indefinitely. Acceptable at low volume; revisit if it becomes material |
| 6 | **Rounding is half-up** (Jack, 2026-08-07) — a half cent rounds away from zero, in accrual and in reversal alike | A designer reproducing our arithmetic by hand gets our number. Must be pinned by a half-cent fixture test, not left to a language default (§7) |

### Three follow-ups these decisions create

- **Designer contracts must use the same basis wording as §7** — "% of net sales
  excluding shipping and tax", not "% of revenue". A mismatch between contract
  language and the computation is a dispute waiting to happen, and it is cheaper
  to fix in the contract template than in the ledger.
- **Connect KYC is a lead time, not a step.** Treat designer onboarding as
  beginning at contract signature, not at first payout.
- **The designer contract must carry the termination story, because the schema
  will not.** `Product.designerId` is immutable (Jack, 2026-08-07): a product's
  royalty payee is fixed for as long as we sell the product, and there is no
  reassignment and no kill switch — an `inactive` designer keeps accruing on
  existing products (§8). So the contract, not the system, is where "what
  happens if this relationship ends?" gets answered. The realistic levers are
  retiring the product from sale or settling commercially; both belong in the
  template before the first designer signs, not after the first dispute.

Nothing in this section blocks implementation.

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
multi-currency royalties (single-currency USD, consistent with `Variant`);
**multi-creator products, split percentages and split-attribution schemes —
excluded by decision (Jack, 2026-08-07), not deferred; designer reassignment,
effective-dated product↔designer associations and designer-history tables —
likewise excluded by decision (Jack, 2026-08-07), because `Product.designerId`
does not change.**

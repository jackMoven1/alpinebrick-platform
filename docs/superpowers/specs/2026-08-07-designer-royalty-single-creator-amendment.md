# Designer Royalty — Single-Creator Amendment

**Date:** 2026-08-07
**Status:** **APPROVED by Jack, 2026-08-11.** The change set below is cleared to
be applied to the accepted spec by the Engineering Lead. **It has not been
applied yet** — until it is, `2026-08-04-designer-royalty-design.md` still reads
"Accepted" and still describes the `ProductDesigner` join table with splits.
Approval is authority to make the edits, not a record that they were made.

**Approved with the six decisions re-confirmed one by one (Jack, 2026-08-11)** —
§3.1 through §3.6 as recorded. One clarification came with that pass: in-house
`own_designed` products with no designer **"will never happen"** (§3.4). And the
one narrow question the sixth decision raised is now **answered — the pre-sale
correction is allowed** (§3.6).
**Decisions recorded:** **six**, all ruled on by Jack on **2026-08-07**. The
first five answer questions raised in the first draft of this amendment, each
ruled as recommended. The **sixth** (§3.6 — `Product.designerId` is immutable)
was a ruling Jack issued on his own initiative, not an answer to a question put
to him. §3 is a record of all six, and their consequences are propagated into
the normative change list in §1 and the plain-language model in §2.
**The narrow question raised by the sixth decision is closed (Jack,
2026-08-11):** a write to `designerId` *before a product's first sale* — a
creation-time typo, or a designer engaged after the product record exists — is
**permitted**, on the terms in §3.6: only while the product has **zero**
`RoyaltyRecord`s, admin-only, audit-logged, and forbidden absolutely thereafter.
**What remains:** applying the §1 change list to the accepted spec. That is the
Engineering Lead's, and it is the only step between this document and a spec
that describes the system we are actually building — see §6.
**Author:** Affiliate / Partnerships Manager (drafted for Jack)
**Amends:** [`2026-08-04-designer-royalty-design.md`](2026-08-04-designer-royalty-design.md)
(Status: Accepted)
**Implements:** Jack's decision of **2026-08-07** — *a product has exactly one
creator, never several.*

---

## 0. What this amendment does and why

On 2026-08-04 the designer-royalty design was accepted with a **multi-designer**
model: a `ProductDesigner` join table carrying `splitBps` per designer, a
sum-to-10000 invariant, a `splitBpsSnapshot` on every royalty record, and a
largest-remainder allocation step in the amount calculation.

On **2026-08-07 Jack decided that a product has a single creator relationship —
never several.** No split percentages, no tie-breaking, one order line → one
royalty record → one payee.

This decision **post-dates the accepted spec and supersedes the parts of it that
divide a royalty between payees.** The rest of the 2026-08-04 spec stands: the
per-order-line grain, the basis *definition*, snapshotting, the clawback status
model, Stripe Connect payouts, and the non-goals.

**Five further decisions were taken by Jack on the same day, 2026-08-07**, on
questions this simplification exposed — discount allocation, rounding direction,
partial-refund reversal, in-house products, and the record's name. They are
recorded in **§3** and carried into the change list in §1. Two of them touch
sections §0 would otherwise have called untouched: the *allocation* of discounts
to lines is now specified (§3.1, and §3.1.1 for the required Plan 2 change), and
§6's partial-refund paragraph is replaced (§3.3, applied in §1.9a). The statuses
and the clawback debt semantics themselves are unchanged.

**A sixth decision followed, also 2026-08-07, and it removes rather than adds:
`Product.designerId` is immutable for the life of the product.** Designer
reassignment is not a supported operation — *"it's assumed that the designer
will be consistent for the full life of the product"* (Jack, 2026-08-07). This
is recorded in **§3.6**. It makes the single FK a genuinely write-once field and
narrows the snapshotting rationale in §5.4 back to what it was always really
about: **rates change; designers do not.**

**Scope of the change:** remove the machinery for dividing a royalty between
multiple payees, settle the five questions that removal exposed, and record the
immutability of the resulting foreign key. Nothing is added to the royalty
schema except a single nullable foreign key and the column that the join table
used to carry; the one addition *outside* it is `OrderLine.discountCents` on the
orders side, specified in §3.1.1. Decision 6 adds **no field at all** — it adds
a guard (§3.6) and deletes a justification (§1.9).

**Standing flag, restated because it is the easiest thing here to get wrong:**
royalty is computed **per order line**, not per order. A mixed cart of
collectibles and designer sets owes royalty **only on the designer lines**. The
affiliate rails (`AffiliatePartner → CommissionRecord → Payout`) are specced per
attributed paid *order*; using them unmodified for designer royalty silently
overpays or underpays. The accepted spec already handles this correctly via a
parallel line-grained `RoyaltyRecord` (§4) — this amendment does not disturb it,
and the Engineering Lead should not "simplify" toward the order grain while
simplifying away the splits. The two are unrelated changes.

**Not in scope:** any change to affiliate commission, attribution, cookie
windows or fraud controls. Designer attribution is intrinsic to the product —
no last-click, no cookie window, no attribution-fraud surface. Do not import
affiliate attribution machinery into royalty while editing this spec.

---

## 1. Section-by-section change list

Line numbers refer to `2026-08-04-designer-royalty-design.md` as it stands at
the time of writing (320 lines). Quotes are abridged to the load-bearing phrase;
the replacement text is complete and can be pasted.

### 1.1 Header block (lines 3–6) — ADD a cross-reference

**Currently:**

> **Status:** **Accepted** — all commercial questions approved by Jack 2026-08-04
> (§9). Awaiting Engineering Lead review of the technical design.

**Add immediately after the `**Related:**` line (line 13):**

```
**Amended by:** [Single-creator amendment](2026-08-07-designer-royalty-single-creator-amendment.md)
(Jack, 2026-08-07 — exactly one creator per product, **and that creator is fixed
for the life of the product**, plus five decisions taken the same day on
discounts, rounding, reversal, in-house products and naming). Sections 2, 3,
5.2, 5.3, 5.4, **6**, 7, 8, 9 and 11 below are superseded as set out there.
Where this spec and the amendment disagree, **the amendment wins.**
```

*Rationale: a reader who finds the accepted spec first must not implement the
join table. Belt and braces — the sections are edited too, but the pointer is
what saves someone skim-reading.*

---

### 1.2 §2 Scope (lines 52–54) — CHANGE

**Currently:**

> **In scope:** designer records; product↔designer association with revenue
> splits; rate resolution and snapshotting; per-order-line royalty accrual; …

**Replace with:**

```
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
```

**And replace the out-of-scope sentence (lines 56–58) with:**

```
**Out of scope:** designer recruitment/contracting; the vendor procurement flow
and purchase orders; COGS and margin reporting (see §10); a designer-facing
portal (§9); changes to affiliate commission behaviour; **multi-creator products
and any form of split attribution (Jack, 2026-08-07 — a product has exactly one
creator); designer reassignment on an existing product (Jack, 2026-08-07 —
`Product.designerId` is immutable; see §5.2); an internal "house designer"
record for in-house `own_designed` products (Jack, 2026-08-07 — those carry
`designerId NULL` and generate no royalty record at all).**
```

*The `NULL` semantics and the immutability are stated here as well as in §5.2
deliberately: §2 is where a reader decides whether their product is in scope,
and both "in-house designs owe nobody" and "you get one shot at setting this
field" are answers they need before they reach the schema.*

---

### 1.3 §3 decision 2 (lines 68–69) — REPLACE

**Currently:**

> 2. **A product may have multiple designers**, via a join table carrying each
>    designer's split percentage.

**Replace with:**

```
2. **A product has exactly one designer, or none** (Jack, 2026-08-07 —
   superseding the 2026-08-04 multi-designer decision). Modelled as a single
   nullable foreign key on `Product`, not a join table. §5.2.
```

---

### 1.4 §3 decision 4 (lines 75–76) — REPLACE

**Currently:**

> 4. **A designer's rate is their own share**, not a product-level pool that is
>    then divided. §5.3.

**Replace with:**

```
4. **A designer's rate applies directly to the line basis.** There is no pool
   and nothing to divide — the resolved rate times the basis *is* the amount
   owed. §5.3, §7.
```

*Note for the Engineering Lead: this decision is not reversed, it is made
trivial. The commercial intent (the contract percentage is what the designer
earns) is unchanged; the "not a pool" clause simply no longer has a counterpart
to contrast with.*

---

### 1.5 §5.2 (lines 122–136) — REPLACE THE WHOLE SUBSECTION

**Currently** (heading, table and all three bullets):

> ### 5.2 New: `ProductDesigner` (join, with splits)
> … | `splitBps` | int | This designer's share **of the royalty**, in basis points |
> … - **`splitBps` across all designers on a product MUST sum to exactly 10000.**
>   Enforced in a transaction on every write. A product with a single designer has
>   `splitBps = 10000`.

**Replace the entire subsection with:**

```
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
  enforces quietly stops being true. See §3.6 for the recommendation and its
  reasoning; the short version is an application-level guard on the product
  update path, plus a database trigger as a backstop once the product has any
  `RoyaltyRecord`. The `AuditLog` row that every mutation already writes is the
  detector, not the guard.
```

*Prisma sketch, for whoever writes the migration — the Engineering Lead owns the
final naming; `royaltyRateOverrideBps` is proposed over a bare `rateOverrideBps`
because `Product` will eventually carry other rates and a bare name will not age
well:*

```prisma
model Product {
  // … existing fields unchanged …
  designerId             String?   @map("designer_id")
  designer               Designer? @relation(fields: [designerId], references: [id], onDelete: Restrict)
  royaltyRateOverrideBps Int?      @map("royalty_rate_override_bps")

  @@index([designerId])
}
```

`onDelete: Restrict` is deliberate: a designer with products (and therefore with
earned royalty history) must not be deletable out from under a payout record.

**Prisma cannot express the immutability.** There is no `@immutable`, and a
`CHECK` constraint cannot see the previous row, so "does not change" is a
*transition* constraint that no declarative column attribute reaches. That is
precisely why §3.6 recommends where to put the guard instead of leaving the
invariant to the schema — a rule the schema cannot state is a rule the schema
cannot keep.

---

### 1.6 §5.3 rate resolution (lines 138–162) — REPLACE THE CHAIN AND CUT THE SPLIT SEMANTICS

**Currently (line 143):**

> ```
> effectiveRateBps = ProductDesigner.rateOverrideBps ?? Designer.defaultRateBps
> ```

**Replace with:**

```
effectiveRateBps = Product.royaltyRateOverrideBps ?? Designer.defaultRateBps
```

**Currently (lines 146–147):**

> Resolved **per designer per product**, so a collaboration can mix an overridden
> rate for one designer with the default for another.

**Replace with:**

```
Resolved **per product**. There is at most one designer, so there is exactly one
rate to resolve and nothing to reconcile between payees. If `designerId` is
`NULL`, no rate is resolved and no royalty record is written.
```

**Currently (lines 153–157), the second paragraph of the blockquote:**

> `splitBps` therefore governs how a **shared** royalty is apportioned when
> designers are paid from one pool; with a single designer it is always 10000.
> For a straightforward collaboration where each designer earns their own
> contracted rate independently, give each `splitBps = 10000` on their own
> record — the split only divides where a pooled arrangement is intended.

**DELETE this paragraph entirely.** It has no referent once `splitBps` is gone.

**KEEP** the first blockquote paragraph (lines 149–151, "`effectiveRateBps` is
the rate for that designer's own share…") with one edit — **currently:**

> `effectiveRateBps` is the rate for **that designer's own share**. A designer
> contracted at 5% earns 5% of the basis, whether they worked alone or alongside
> others.

**Replace with:**

```
> **Semantics — decided (Jack, 2026-08-04, simplified 2026-08-07).**
> `effectiveRateBps` is applied straight to the line basis. A designer
> contracted at 5% earns 5% of the basis on every line of their product. There
> is no other payee on the line, so there is no share to compute.
```

**KEEP unchanged** the contract-dependency paragraph (lines 159–162). It matters
more, not less, now: the number in the contract must be the number in
`defaultRateBps` / `royaltyRateOverrideBps`, and there is no longer a pool that a
misworded contract could be argued into.

---

### 1.7 §5.4 grain statement (lines 166–167) — REPLACE

**Currently:**

> One row **per (order line, designer)**. A two-designer product on one line
> produces two rows.

**Replace with:**

```
**One row per designer order line — at most one.** A line whose product has
`designerId` set produces exactly one royalty record with exactly one payee. A
line whose product has `designerId NULL` produces none. Enforce with a **unique
constraint on `orderLineId`**: the database should make a second payee on a line
impossible, not merely unwritten.
```

*The unique constraint is the mechanical guarantee that Jack's decision holds
even if someone later writes a careless backfill. Cheap; take it.*

---

### 1.8 §5.4 `splitBpsSnapshot` row (line 176) — DELETE

**Currently, a row in the `RoyaltyRecord` field table:**

> | **`splitBpsSnapshot`** | int | Split **as it stood at time of sale** |

**Delete the row.** Nothing replaces it. `rateBpsSnapshot` (line 175) stays
exactly as written — snapshotting the *rate* is still mandatory.

**Also change the `orderLineId` row (line 172) — currently:**

> | `orderLineId` | FK → `OrderLine` | The grain. Indexed |

**Replace with:**

```
| `orderLineId` | FK → `OrderLine` | The grain. **Unique** — one line, one record, one payee |
```

**And change the `designerId` row (line 173) — currently:**

> | `designerId` | FK → `Designer` | Indexed |

**Replace with:**

```
| `designerId` | FK → `Designer` | **The payee.** Indexed — payouts batch by it (§8). Not a snapshot: `Product.designerId` is immutable, so this cannot diverge from the product's designer |
```

*Retained deliberately. See the added paragraph in §1.9 for why the column
survives the immutability decision and why "derivable by join" is not a reason
to drop it from a record that money is paid against.*

---

### 1.9 §5.4 snapshotting rationale (lines 183–186) — CHANGE

**Currently** (the first two sentences of the paragraph, running from line 183 to
the words "including sales already paid out." partway through line 186):

> **Snapshotting is mandatory, not an optimisation.** Rates and splits are
> editable. If royalties were computed by looking up the current rate, editing a
> designer's `defaultRateBps` would retroactively rewrite what every past sale
> earned — including sales already paid out.

**Replace those two sentences with** (the trailing sentence "This mirrors the
redesign spec's existing rule that affiliate attribution is snapshotted onto the
order." — rest of line 186 into 187 — **stays**):

```
**Snapshotting the rate is mandatory, not an optimisation.** Rates are editable:
`Designer.defaultRateBps` and `Product.royaltyRateOverrideBps` can both change,
and a rate renegotiated in year two must not restate year one. If royalties were
computed by looking up the current rate, editing a designer's `defaultRateBps`
would retroactively rewrite what every past sale earned — including sales
already paid out. `rateBpsSnapshot` is what makes an accrued record a historical
fact rather than a query against live configuration.

**The designer needs no such protection.** `Product.designerId` is immutable
(§5.2, Jack 2026-08-07), so there is no reassignment for a snapshot to defend
against. `RoyaltyRecord.designerId` is carried for a different reason — it is
the **payee** on a financial record, not a defence against drift. See below.
```

*Narrowed 2026-08-07 by decision §3.6. An earlier draft of this amendment
justified snapshotting partly by the risk that a single-FK `designerId` was a
one-column `UPDATE` anyone might make casually. Jack's ruling removes that risk
at the source — the update is not allowed at all — so the justification is
withdrawn rather than left standing on a hazard that no longer exists. Only the
rate rationale survives, which is the one the accepted spec already had. Keeping
a retracted argument in a money spec is how a future reader concludes
reassignment must be possible, since the document is clearly worried about it.*

**And ADD, immediately after that paragraph and before "Every mutation writes an
`AuditLog` row":**

```
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
```

*This is the one place where the immutability ruling could plausibly be read as
licence to simplify the schema further. It is not. Dropping the payee from a
payout-bearing record to save a column would be a poor trade even if it were
sound, and it is not sound: §8 batches by designer.*

---

### 1.9a §6 partial-refund reversal (lines 216–220) — REPLACE

*Added 2026-08-07 by decision §3.3. Numbered `1.9a` so the entries either side
keep the numbers the Engineering Lead may already have referenced. §6 was
previously listed in §1.16 as unchanged; it is not — this entry supersedes that
listing.*

**Currently:**

> **Partial refunds reverse proportionally.** Refunding 1 of 3 units on a line
> reverses one third of that line's royalty, accumulated in
> `reversedAmountCents` rather than by flipping `status`. Status changes only when
> the line is fully reversed. Net payable is always
> `amountCents - reversedAmountCents`.

**Replace with:**

```
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
```

*Why this and not pro-rating the stored `amountCents` by units refunded: one
formula for accrual and reversal stays correct when a refund is **not**
proportional — a goodwill partial refund on a single unit, which is likelier
than it sounds. See §3.3.*

**Note for the Engineering Lead:** `round_half_up` here is the same function as
in §7 (§1.10 below), not a second rounding policy. If accrual and reversal ever
round differently, a fully refunded line stops netting to zero — worth one test
that refunds a line in three unequal steps and asserts the net is exactly `0`.

---

### 1.10 §7 the calculation (lines 226–231) — REPLACE THE CODE BLOCK

**Currently:**

> ```
> basisCents  = orderLine.subtotalCents - orderLine.discountCents
>               (excludes shipping and tax entirely)
> poolCents   = round(basisCents * effectiveRateBps / 10000)
> amountCents = largest_remainder_split(poolCents, [splitBps...])
> ```

**Replace with:**

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

Two notes attached to that replacement, both of which the Engineering Lead
should carry into the code:

1. **Rounding is half-up — decided (Jack, 2026-08-07), §3.2.** Half-up,
   half-even and floor give different answers and largest-remainder is no longer
   there to absorb the difference, so the direction is named in the spec text
   above and must be pinned by a test with half-cent fixtures. The same
   `round_half_up` is used for reversals (§1.9a); one function, two call sites.
2. **Field names, reconciled — decided (Jack, 2026-08-07), §3.1.** The accepted
   spec says `orderLine.subtotalCents`; the `OrderLine` model in
   `../plans/2026-07-08-phase2-orders-inventory-tax.md` (line 305) is
   `lineSubtotalCents`. **Plan 2's name wins** — the replacement text above uses
   it. And **`orderLine.discountCents` does not exist in Plan 2 at all** —
   neither `Order` nor `OrderLine` models any discount field today (plan lines
   279–309), so the basis is not computable against the planned schema as it
   stands. Decision §3.1 settles what to do: the exact required change to Plan 2
   is specified in **§3.1.1**, and it must land before royalty accrual is
   implemented.

---

### 1.11 §7 rounding rule (lines 245–250) — REPLACE

**Currently:**

> **Rounding rule — largest remainder.** Splitting an integer-cent pool by
> percentages produces fractional cents. Naive per-designer rounding makes the
> parts fail to sum to the whole: three designers splitting 100¢ evenly round to
> 33¢ each and lose a cent every sale. Allocate floors first, then distribute the
> remaining cents one at a time to the largest fractional remainders, ties broken
> by `designerId` for determinism.

**Replace with:**

```
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
```

> **Do not delete the largest-remainder helper from the codebase if one already
> exists.** It stops being needed for royalty *between payees*, but it is now
> **required** on a different axis: allocating an **order-level discount across
> order lines** at order creation, where the parts must still sum to the whole
> exactly (decided — §3.1, specified in §3.1.1). Same algorithm, different axis.

---

### 1.12 §7 invariant (lines 252–254) — REPLACE

**Currently:**

> **Invariant, worth an explicit test:** the sum of `amountCents` across a line's
> royalty records equals `poolCents` exactly, for every combination of split
> percentages and basis amounts.

**Replace with:**

```
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
```

---

### 1.13 §8 first bullet (lines 260–262) — REPLACE

**Currently:**

> - **Order paid** → for each order line, resolve the product's designers; if any,
>   snapshot rate and split, compute amounts, write `RoyaltyRecord`s in the same
>   transaction that marks the order paid.

**Replace with:**

```
- **Order paid** → for each order line, resolve the product's `designerId`; if
  set, snapshot the designer and the resolved rate, compute the amount, and
  write **one** `RoyaltyRecord` in the same transaction that marks the order
  paid. Lines whose product has no designer are skipped silently — that is the
  correct behaviour for every collectible line.
```

**Also §8 third bullet (lines 264–265) — currently:**

> - **Product's designers edited** → affects future sales only. Existing records are
>   immutable by virtue of their snapshots.

**Replace with:**

```
- **Product's rate override edited** → affects future sales only. Existing
  records keep their `rateBpsSnapshot` and are unaffected.
- **Product's designer edited** → **does not happen.** `Product.designerId` is
  immutable (§5.2, Jack 2026-08-07); the update is rejected. There is no
  "re-attribute future sales" behaviour to specify, because there is no
  reassignment.
```

*Two bullets rather than one, because the two fields no longer behave alike: the
rate is mutable and forward-acting, the designer is not mutable at all. Folding
them into a single "product's designer or rate edited" bullet — as an earlier
draft of this amendment did — implies the designer can be edited, which is
exactly the premise Jack's 2026-08-07 ruling removes.*

---

### 1.14 §9 decisions table, rows 1 and 2 (lines 283–284) — REPLACE

**Row 1 currently:**

> | 1 | **A designer's rate is their own share**, not a product pool that is divided | The contract percentage must equal the stored rate — see the contract dependency in §5.3 |

**Replace with:**

```
| 1 | **A designer's rate applies directly to the line basis** (simplified by the one-creator decision, Jack 2026-08-07) | The contract percentage must equal the stored rate — see the contract dependency in §5.3 |
```

**Row 2 currently** — its consequence is now settled and must stop reading as
outstanding:

> | 2 | **Basis = line revenue net of line-level discounts, excluding shipping and tax** | Requires **line-level** discount amounts. If Plan 2 only models order-level discounts, allocation to lines must be settled first (§7) |

**Replace with:**

```
| 2 | **Basis = line revenue net of line-level discounts, excluding shipping and tax** | Requires **line-level** discount amounts. **Settled (Jack, 2026-08-07):** checkout pro-rates any order-level discount across lines by line subtotal and persists `OrderLine.discountCents`; royalty reads the stored value and never re-derives it. Plan 2's `OrderLine` must gain that column before accrual is implemented — see §3.1 and §3.1.1 of the single-creator amendment |
```

**And add a new row 6**, since the amendment settles a commercial question §9
did not previously carry:

```
| 6 | **Rounding is half-up** (Jack, 2026-08-07) — a half cent rounds away from zero, in accrual and in reversal alike | A designer reproducing our arithmetic by hand gets our number. Must be pinned by a half-cent fixture test, not left to a language default (§7) |
```

*Row 6 belongs in §9 rather than only in the amendment because it is the rule a
designer's contract is read against — it is a commercial decision wearing
technical clothes, and the person answering "why is my royalty 250¢ and not
249¢?" needs it in the spec they are holding.*

**Consequential edits in the same section** — adding a row makes two lines
stale:

- **§9 heading (line 277)** — currently *"## 9. Commercial decisions — approved
  by Jack 2026-08-04"*. Replace with:

  ```
  ## 9. Commercial decisions — approved by Jack 2026-08-04, extended 2026-08-07
  ```

- **§9 lead sentence (line 279)** — currently *"All five were approved as
  recommended. Recorded here with their consequences."* Replace with:

  ```
  All five were approved as recommended on 2026-08-04. Row 6 was added
  2026-08-07 with the single-creator amendment, likewise as recommended.
  Recorded here with their consequences.
  ```

**And ADD a third follow-up** to *"Two follow-ups these decisions create"*
(lines 289–296), renaming that heading to **"Three follow-ups these decisions
create"**:

```
- **The designer contract must carry the termination story, because the schema
  will not.** `Product.designerId` is immutable (Jack, 2026-08-07): a product's
  royalty payee is fixed for as long as we sell the product, and there is no
  reassignment and no kill switch — an `inactive` designer keeps accruing on
  existing products (§8). So the contract, not the system, is where "what
  happens if this relationship ends?" gets answered. The realistic levers are
  retiring the product from sale or settling commercially; both belong in the
  template before the first designer signs, not after the first dispute.
```

*This is the partner-facing consequence of decision §3.6 and it belongs in §9
rather than only in the amendment: §9 is the section a contract template gets
drafted against. It is also the point at which an engineering decision becomes
an Affiliate/Partnerships deliverable — the contract template is mine to draft
and Jack's to approve.*

---

### 1.15 §11 Non-goals (lines 316–319) — ADD

**Currently:**

> Designer contracting and recruitment; vendor/PO management; COGS and margin
> reporting; a designer portal; changes to affiliate attribution or commission;
> multi-currency royalties (single-currency USD, consistent with `Variant`).

**Replace with:**

```
Designer contracting and recruitment; vendor/PO management; COGS and margin
reporting; a designer portal; changes to affiliate attribution or commission;
multi-currency royalties (single-currency USD, consistent with `Variant`);
**multi-creator products, split percentages and split-attribution schemes —
excluded by decision (Jack, 2026-08-07), not deferred; designer reassignment,
effective-dated product↔designer associations and designer-history tables —
likewise excluded by decision (Jack, 2026-08-07), because `Product.designerId`
does not change.**
```

*"Excluded, not deferred" is the operative wording. A non-goal phrased as "later"
invites someone to leave a hook in the schema for it. Effective-dating is named
explicitly because it is the shape a reassignment hook would take if one crept
back in — and it would look like good practice while doing it.*

---

### 1.16 Sections that do **not** change — and two that partly do

Listed so the Engineering Lead can skip them with confidence. **Two rows are
qualified**: the 2026-08-07 decisions reached into §6 and §9, which the first
draft of this amendment listed as untouched. Read the qualifications before
skipping.

| Section | Why it survives |
|---|---|
| §1 Context | No split content. The "why this is easier than affiliate commission" argument gets *stronger*, not weaker |
| §4 The critical modelling point | **Per-order-line grain is untouched.** This is a separate concern from splits — do not simplify it away in the same pass. The table name `RoyaltyRecord` is **confirmed**, not merely inherited (Jack, 2026-08-07 — §3.5); do not fold royalty into `CommissionRecord` |
| §5.1 `Designer` | Unaffected. Basis-points rule stands. No internal "house designer" is added (§3.4). **Note the `status` field now carries more weight:** with `Product.designerId` immutable (§3.6), setting a designer `inactive` is the *only* lever over an existing relationship, and per §8 it deliberately does not stop accrual on existing products. That combination is intended, not an oversight — see §3.6 |
| §6 statuses and clawback semantics | The four statuses and the clawback debt semantics are unchanged — **but the partial-refund paragraph (lines 216–220) does change**, per decision §3.3. See **§1.9a**, which supersedes this row's earlier "unaffected" listing |
| §9 rows 3–5 and both follow-ups | Portal, Connect KYC, clawback netting — all unaffected. **Rows 1 and 2 do change** (§1.14), and a row 6 is added |
| §10 Procurement and margin | Unaffected |

---

## 2. The replacement model, stated plainly

For anyone who wants the answer without the diff:

**Schema.** `Product` gains a single nullable foreign key `designerId`, plus a
nullable `royaltyRateOverrideBps` that used to live on the join table.
`designerId NULL` means the product owes no royalty — that covers every
collectible (`ProductType.resale`) and any in-house `own_designed` product, which
stays `NULL` rather than pointing at a 0-bps house designer (Jack, 2026-08-07).
`designerId` set means the product has one creator, and that creator is the only
possible payee. **There is no `ProductDesigner` table.**

**`designerId` is written once and never changed** (Jack, 2026-08-07) — the
designer is consistent for the full life of the product. Reassignment is not a
supported operation, in any direction. If a designer relationship ends, the
product is retired, not moved to someone else (§3.6).

**Accrual.** One order line → at most one `RoyaltyRecord` → exactly one payee.
The record is called `RoyaltyRecord`, not `CommissionRecord` — decided (Jack,
2026-08-07); the two differ in grain, attribution source and lifecycle (§3.5).
Enforced by a unique constraint on `orderLineId`, not by convention. Royalty is
computed **per order line**: a mixed cart of collectibles and designer sets
accrues on the designer lines only, and the collectible lines produce no record
at all.

**Rate.** `effectiveRateBps = Product.royaltyRateOverrideBps ?? Designer.defaultRateBps`,
snapshotted onto the record at sale so that a later **rate** edit cannot rewrite
what a past sale earned. The rate is the only thing that needs snapshotting: the
designer cannot change, so `RoyaltyRecord.designerId` is carried as the **payee**
on the record rather than as a defence against drift (§1.9).

**Amount.**

```
basisCents  = orderLine.lineSubtotalCents - orderLine.discountCents
              (excludes shipping and tax entirely)
amountCents = round_half_up(basisCents * rateBpsSnapshot / 10000)
            = (basisCents * rateBpsSnapshot + 5000) / 10000   // integer div
```

**No pool. No split. No allocation step inside royalty. No tie-break between
payees.** Rounding is **half-up** — decided (Jack, 2026-08-07), §3.2 — in accrual
and in reversal alike.

*(The one surviving allocation is on the orders side, not this one: an
order-level discount is allocated across lines at checkout. Different axis, and
it happens before royalty ever runs — §3.1.1.)*

**Discounts.** `OrderLine.discountCents` is the line's share of any order-level
discount, **allocated at order creation and stored** — not re-derived at royalty
time (Jack, 2026-08-07, §3.1). Plan 2 does not model that column yet; §3.1.1
specifies exactly what to add.

**Reversal.** A refund reverses by recomputing from the refunded basis with the
same formula and the same snapshotted rate — `round_half_up(cumulative
refundedBasisCents * rateBpsSnapshot / 10000)`, capped at `amountCents` (Jack,
2026-08-07, §3.3). A fully refunded line nets to exactly zero and never below.

**And what is *not* in this model, deliberately:** no last-click policy, no
cookie window, no attribution-fraud surface. The designer is a property of the
product, so attribution is not contestable. Fraud-watch effort belongs on the
affiliate side, where it is.

---

## 3. Decisions — recorded, settled by Jack 2026-08-07

**All five questions raised in the first draft of this amendment were ruled on by
Jack on 2026-08-07, each as recommended** (§3.1–§3.5). **A sixth decision, §3.6,
was issued by Jack the same day without being asked for** — it is a ruling, not
an answer, and it is recorded in the same format so the six read as one set. This
section is a record of those decisions, not a list of open items.

The options **not** taken are kept, each with its one-line reason. They are not
clutter: they are why the decision holds, and the next person to propose banker's
rounding or a house designer should be able to see it has already been argued.

**What this section does not do.** It does not apply anything. The six decisions
were settled 2026-08-07 and **the amendment as a whole was approved 2026-08-11**
(§6), but the §1 change list has still not been applied to the accepted spec.
§3.6's narrow question is now **answered** — the pre-sale correction is allowed;
see the ruling at the end of it.

Each decision names where it lands in normative text under **Applied in**. If a
decision and the §1 change list ever disagree, the change list is wrong and gets
fixed to match here.

### 3.1 Discount allocation — line-level vs order-level

**DECIDED (Jack, 2026-08-07) — option (a), as recommended.** Any order-level
discount is **allocated across lines at order creation and persisted as
`OrderLine.discountCents`**. Royalty reads the stored value and never re-derives
it.

**The problem it answers.** §7 defines the basis as line revenue *net of
line-level discounts*. But `OrderLine` in Plan 2
(`../plans/2026-07-08-phase2-orders-inventory-tax.md`, lines 296–309) has **no
discount field**, and neither does `Order` (lines 279–294). So a 10%-off
order-level code applied to a mixed cart of two collectibles and one designer set
has nowhere to record how much of that discount landed on the designer line — and
the basis is not computable. Not a rounding nicety: it changes what we owe on
every discounted mixed cart.

**Why this option.** The basis must be reproducible from stored data years later,
when a designer queries a payout. Storing the allocation puts it where the money
actually moves — at checkout, where the discount is known — rather than in the
royalty engine, and it means the answer to "how did you get that number?" is a
row in a table rather than a reconstruction.

**Considered and not taken:**

- **(b) Store the discount at order level only and allocate at royalty time.**
  Fewer schema changes now, but the figure would depend on whichever allocation
  policy the code held when it ran — a later policy change silently restates
  history that a designer has already been shown.
- **(c) Exclude discounts from the basis** (royalty on gross line revenue).
  Simplest, but it **reverses** an already-approved decision (§9 row 2) and pays
  full royalty on a set we discounted to clear. A commercial reversal should not
  be made as a side effect of a technical convenience.

**Applied in:** §1.2 (scope), §1.10 (the calculation, its field names, and note
2), §1.11 (the largest-remainder helper is now *required* on the discount axis),
§1.12 invariant 5, §1.14 (§9 row 2), §2, and §3.1.1 immediately below.

---

#### 3.1.1 Required change to Plan 2 — `OrderLine.discountCents`

**This subsection is a specification for the Engineering Lead to apply. This
amendment does not edit the Plan 2 file.** It is included here because 3.1 was
flagged as *blocking* rather than merely open, and a decision that leaves its
consequence unspecified is not actually settled.

**Target:** `docs/superpowers/plans/2026-07-08-phase2-orders-inventory-tax.md`,
Task 2 → Step 4, the two Prisma models appended at **lines 279–309**. Line
numbers verified against that file on 2026-08-07.

**(1) Add one column to `OrderLine`** (model at lines 296–309), immediately after
`lineSubtotalCents` (line 305):

```prisma
  discountCents     Int     @default(0) @map("discount_cents")
```

- **Type:** `Int`, integer cents, consistent with every other money field in the
  model. Never a float, never a percentage.
- **`@default(0)`** so the change is additive: order-creation code that does not
  yet apply discounts keeps working, and `basisCents = lineSubtotalCents -
  discountCents` is correct from the first migration onward.
- **Mapping:** `@map("discount_cents")`, matching the snake_case column
  convention already used throughout both models.
- **Sign convention:** stored **positive**, and **subtracted** in the basis. It
  is a discount amount, not a signed adjustment. `0 <= discountCents <=
  lineSubtotalCents` on every row.

**(2) Add the matching column to `Order`** (model at lines 279–294), after
`subtotalCents` (line 285):

```prisma
  discountCents   Int         @map("discount_cents") @default(0)
```

Without it there is nothing for the per-line allocation to sum back to, and the
reconciliation invariant below is unenforceable.

**(3) The allocation rule**, which belongs in order creation, inside the same
transaction that writes the lines:

```
For an order-level discount D across lines L1..Ln with subtotals S1..Sn:

  raw_i    = D * S_i / sum(S)                    // exact rational
  floor_i  = floor(raw_i)
  residual = D - sum(floor_i)                    // 0 <= residual < n

Distribute the `residual` cents one at a time to the lines with the largest
fractional remainders (raw_i - floor_i). Break ties by ascending line index in
the submitted order — deterministic, and available at creation time before ids
are assigned.
```

Invariants worth a test in Plan 2's own suite, not only in royalty's:

- `sum(OrderLine.discountCents) == Order.discountCents` **exactly**, for every
  order. This is the whole point of largest-remainder here.
- `0 <= OrderLine.discountCents <= OrderLine.lineSubtotalCents` on every line.
- A discount applied to a mixed cart of collectibles and designer sets lands on
  **both** kinds of line. Royalty then reads only the designer lines. Do not
  "optimise" by allocating discount only to designer lines — that would
  understate what the customer paid for the collectibles and overstate our own
  margin figures.

**(4) Field-name reconciliation.** The accepted royalty spec §7 writes
`orderLine.subtotalCents`; Plan 2's field is **`lineSubtotalCents`** (line 305).
**Plan 2's name wins.** The royalty spec is the document that changes — §1.10 of
this amendment already writes the basis as `orderLine.lineSubtotalCents -
orderLine.discountCents`. Do **not** rename Plan 2's field to match the spec: the
`Order.subtotalCents` / `OrderLine.lineSubtotalCents` asymmetry is deliberate in
Plan 2, and renaming buys a migration and a diff for nothing.

**(5) Sequencing — this is the blocking part.** The column must exist before
royalty accrual is implemented. If Plan 2 ships without it and royalty is built
anyway, the failure is **silent**: `discountCents` is simply absent, the basis
falls back to gross line revenue, and we **overpay every designer on every
discounted line** with no error raised anywhere. That is the same class of
failure as computing royalty per order instead of per line, and it deserves the
same wariness.

**(6) One consequence to flag, not to decide here.** Plan 2 computes `taxCents`
from `subtotalCents`. Once an order can carry a discount, the tax base is
arguably the **discounted** subtotal, and `totalCents` becomes
`subtotalCents - discountCents + taxCents`. That is a tax-correctness question
owned by the Engineering Lead (and ultimately Jack), **not** a royalty question —
royalty excludes tax entirely either way, so nothing in this amendment depends on
the answer. Raising it only because adding the column is the moment someone will
otherwise get it wrong by omission.

### 3.2 Rounding direction for `round(basisCents * rateBps / 10000)`

**DECIDED (Jack, 2026-08-07) — option (a) half-up, as recommended.** A half cent
rounds **away from zero**. The same rule applies to accrual and to reversal.

**The problem it answers.** Largest-remainder used to absorb sub-cent error. With
a single payee there is one rounding event per line and no invariant forcing a
direction. At 5% on a $49.99 line the fraction is 249.95¢, and 3.3 compounds it
across partial refunds.

**Why this option.** It matches the ordinary reading of "5% of net sales" that a
designer's contract will carry, and a designer checking our arithmetic by hand
reproduces our number. Explicability against a real person's money is the thing
being bought here.

**Considered and not taken:**

- **(b) Half-even (banker's)** — removes systematic upward bias across large
  volumes, but that bias-correction argument applies when parts must sum to a
  whole, which is precisely the invariant the single-creator decision removes. It
  costs explicability for no remaining gain.
- **(c) Floor** — never overpays, but systematically underpays. A rule that can
  only ever shortchange a partner is not one we want to have to explain.

**Implementation, so it is not re-derived.** Basis and rate are both non-negative
integers, so half-up is exact in integer arithmetic:

```
amountCents = (basisCents * rateBpsSnapshot + 5000) / 10000   // integer division
```

Name it in the spec text (done — §1.10, §1.11) and pin it with a fixture whose
product lands exactly on a half cent. Do not lean on `Math.round`: it is
float-based and half-up only for positive values, so its agreement here is a
coincidence rather than a specification.

**Applied in:** §1.10 (calculation and note 1), §1.11 (rounding rule), §1.12
invariant 2, §1.9a (reversal uses the same function), §1.14 (new §9 row 6), §2.

### 3.3 How a *partial* reversal rounds (found while checking §6)

**DECIDED (Jack, 2026-08-07) — option (a) with the cap, as recommended.**
`reversal = round_half_up(refundedBasisCents * rateBpsSnapshot / 10000)`, using
the same formula and the same snapshotted rate as accrual, with
`reversedAmountCents` **capped at `amountCents`**.

**The problem it answers.** §6 says partial refunds reverse proportionally —
"refunding 1 of 3 units reverses one third of that line's royalty". One third of
an integer royalty is fractional, and largest-remainder is no longer available.
Refunding 1 unit, then 1 more, then the last must net to exactly zero; naive
thirds will not.

**Why this option.** One formula for accrual and reversal stays correct when a
refund is **not** proportional — a goodwill partial refund on a single unit,
which is likelier than it sounds. The cap is the guard that a fully refunded line
nets to zero and never below: we do not claw back more than we accrued.

**Considered and not taken:**

- **(b) Pro-rate the stored `amountCents` by units refunded**, residual cent to
  the final reversal — works only while every refund is a whole number of units,
  and silently misbehaves on a cash goodwill refund.

**Implementation detail this decision requires** (carried into §1.9a): compute
the reversal **cumulatively**, against the total basis refunded on the line so
far, and store the result — do not add an independently rounded increment per
refund event. Incremental rounding is exactly what makes three successive
one-third refunds fail to net to zero. The cumulative form plus the cap makes
that impossible.

**Applied in:** §1.9a (the §6 replacement text), §1.12 invariant 3.

### 3.4 Do in-house `own_designed` products get a `Designer` record?

**DECIDED (Jack, 2026-08-07) — option (a), as recommended.** In-house
`own_designed` products keep `designerId NULL`. **No 0-bps internal designer is
created.** No payee, no royalty record, no royalty.

**The problem it answers.** The old §5.2 allowed a product to have zero
designers, covering in-house designs. Under the FK model those are
indistinguishable from collectibles by `designerId` alone (both `NULL`), though
`productType` still separates them.

**Why this option.** `WHERE product_type = 'own_designed' AND designer_id IS
NULL` already answers the reporting question, without inventing a payee.

**Clarified (Jack, 2026-08-11): this case "will never happen."** Every
`own_designed` product is expected to have a real designer, so the
`own_designed` + `NULL` combination is hypothetical rather than a live category.

**Do not turn that into a constraint.** The rule stays exactly as decided —
`designerId NULL` means no royalty, and the NULL branch simply never fires for
`own_designed`. Specifically: **do not add a `CHECK` that `own_designed` implies
`designer_id IS NOT NULL`.** That would tighten the schema on a forecast about
what the business will do, and it is the same shape as the `ChargeType` enum
values deleted on the strength of a DDP "decision" that turned out to be a
hypothesis, then restored. A permissive column costs nothing to carry and one
migration to tighten; a constraint that turns out to be wrong blocks a product
from being saved at the moment someone needs it saved.

**Considered and not taken:**

- **(b) Create an internal "AlpineBrick in-house" `Designer` at 0 bps** so every
  `own_designed` product has attribution — it manufactures royalty records worth
  0¢ that then flow through payout batching and reporting forever. **Do not
  create a payee that is never paid.**

**Applied in:** §1.2 (scope, out-of-scope), §1.5 (§5.2 FK semantics), §1.12
invariant 1, §1.16 (§5.1 row), §2.

### 3.5 Terminology: `RoyaltyRecord` vs `CommissionRecord`

**DECIDED (Jack, 2026-08-07): `RoyaltyRecord`.** The royalty table keeps its own
name; royalty is **not** implemented into `CommissionRecord`.

*Rendering note: Jack typed "royaltyRecord". Written throughout as
**`RoyaltyRecord`** — PascalCase per the Prisma model convention used by every
other model in `schema.prisma`, and matching the accepted spec §4, which already
names it that way. Flagging the change of casing so it is a recorded rendering
choice rather than a silent one; the decision itself is Jack's.*

**The problem it answers.** `CLAUDE.md` line 105 records the decision as *"One
line → one `CommissionRecord` → one payee"*, while the accepted spec §4
deliberately introduces a **separate** `RoyaltyRecord` because the two differ in
grain (line vs order), attribution source (intrinsic vs referral) and lifecycle
(reversible vs not).

**Why this option.** The spec's reasoning for two tables is sound and this
amendment does not disturb it. Implementing royalty *into* `CommissionRecord` on
the strength of that one line would reintroduce the **order-grain bug that §4
exists to prevent** — the one that silently mis-pays every mixed basket.

`CLAUDE.md`'s wording reads as the concept ("one commission-bearing record per
line"), not as a table name. No edit to `CLAUDE.md` is required; the mismatch is
now a known one rather than a discovered one (§5, item 2).

**Applied in:** used consistently throughout this amendment (§0, §1.5, §1.8,
§1.9a, §1.12, §1.13, §2, §4); §1.16 records the confirmation against §4 of the
spec.

### 3.6 `Product.designerId` is immutable — no designer reassignment

**RULED (Jack, 2026-08-07), unprompted:**

> *"Don't deal with re-assignment of designers, once a product is created and
> sold. It's assumed that the designer will be consistent for the full life of
> the product."*

**`Product.designerId` is immutable for the life of the product.** Designer
reassignment is not a supported operation. Do not design for it, do not build
handling for it, do not widen anything to accommodate it.

**What it settles.** The single-FK model (§1.5) made reassignment *mechanically
trivial* — a one-column `UPDATE` where the join-table model needed a delete and
an insert. An earlier draft of this amendment treated that as a new hazard to
defend against, and widened the §5.4 snapshotting rationale to cover it. **That
widening is retracted.** Jack has removed the hazard at the source rather than
asking us to defend against it: the update does not happen, so nothing needs to
survive it.

**Why this is a simplification, not a restriction.** It removes a whole class of
question that would otherwise have to be answered eventually, and answered
carefully because each answer moves money:

- *Does reassignment move unpaid accrued royalty to the new designer?* — no
  question to answer.
- *Does a designer keep earning on sales made before they were removed?* — the
  premise cannot arise.
- *Is `RoyaltyRecord.designerId` a snapshot or a live reference?* — neither; it
  is the payee, and the two can never disagree (§1.8, §1.9).
- *Do we need an effective-dated product↔designer association, or a designer
  history table?* — no. This is the one that mattered: effective-dating is how a
  "just in case" reassignment hook would have crept back in and quietly
  reintroduced a join table by another name.

**Considered and not taken:**

- **(a) Allow reassignment, forward-acting only** (the earlier draft's implicit
  position). Coherent, and the snapshots would have made it safe for *existing*
  records — but it buys an operation nobody has asked for and pays for it with
  an effective-dated association and a permanent "which designer, as of when?"
  question in every report.
- **(b) Allow reassignment with an audit trail and no other guard.** The audit
  log tells you afterwards that future royalty is now going to someone else. It
  does not stop it, and nobody reads an audit log until there is a dispute.
- **(c) Soft-delete and re-create the product on a change of designer.** This is
  effectively what §5.2 recommends operationally (retire, don't reassign) — but
  as a *policy*, not as a mechanism the system offers. Making it a supported
  "change designer" button that silently forks the product would reintroduce
  reassignment wearing a disguise, and would break inventory and order history.

**The consequence to be clear-eyed about.** A product's royalty payee is fixed
for as long as the product is sold. If a designer relationship sours, we cannot
redirect their royalty; the levers are to **stop selling the product**, or to
settle commercially outside the system. This composes with the accepted spec's
§8 rule that an `inactive` designer keeps accruing on existing products —
inactivating is not a kill switch on earned revenue, and now there is no second
lever either. That is the right default for a partner's earned money, but it
should be a known consequence rather than a discovered one, and it belongs in
the designer contract template: **the contract, not the schema, is where a
termination story lives.**

**Recommended enforcement — flagged for Jack, not settled.** A stated invariant
that nothing enforces is the kind of thing that quietly stops being true, and
this one fails *silently*: a reassignment raises no error and misdirects only
*future* royalty, so it surfaces at a payout dispute rather than at the write.

My recommendation, in order:

1. **Application-level guard — primary.** The product update path rejects any
   change to `designerId` on an existing product, with an explicit error naming
   the rule. **Chosen as primary because it is the only layer that can tell a
   reassignment from a correction** (see the flag below), it gives the person
   doing it a comprehensible message instead of a constraint violation, and it
   is testable in the same suite as everything else here (§1.12 invariant 6).
2. **Database trigger — backstop, scoped.** Reject the update once the product
   has **any** `RoyaltyRecord`. That is exactly the line Jack drew — *"created
   and sold"* — and it is the point past which a change would redirect a real
   payee's money. Scoping the trigger this way means it never blocks a
   legitimate pre-sale fix, so nobody is ever tempted to drop it.
3. **`AuditLog` — detector, not guard.** Every mutation already writes one
   (§5.4). It is how we would *find* a violation; it prevents nothing, so it
   cannot be the whole answer.

**Rejected as the whole answer:**

- **Documentation only.** This is the option the invariant would decay under. It
  is also the weakest form of exactly the argument this amendment already made
  for the unique constraint on `orderLineId` (§1.7): *the database should make
  the wrong state impossible, not merely unwritten.* Consistency argues for a
  real guard here too.
- **Audit-log only.** Detects after the money has been misdirected. For a field
  that names who gets paid, after-the-fact is too late.
- **A `CHECK` constraint.** Cannot express it — immutability is a constraint on
  the *transition*, and a `CHECK` cannot see the previous row. Noted because it
  is the first thing someone will reach for.

**Cost: nothing, today.** `Product.designerId` does not exist yet and neither
does `RoyaltyRecord` (§4), so both guards are written once alongside the
migration that introduces the column. Retrofitting a trigger onto a live table
with existing rows is where this gets expensive.

**One narrow question back to Jack.** Jack's words were *"once a product is
created **and sold**"*. Read strictly, immutability from the instant of creation
also forbids two things that are not reassignment and are not obviously wrong:

- **Correcting a creation-time typo** — the wrong designer picked from a
  dropdown, caught before the product ever sells. Under absolute immutability
  the only fix is to delete and re-create the product.
- **Setting `NULL` → a designer** — a product created before the designer
  relationship was signed, then legitimately attributed before launch.

**My recommendation:** treat both as **pre-sale corrections, not
reassignments** — permitted only while the product has **zero** `RoyaltyRecord`s,
admin-only, and audit-logged; forbidden absolutely thereafter. That is what the
two-layer enforcement above implements, and it matches Jack's wording exactly.

**DECIDED (Jack, 2026-08-11) — the pre-sale correction is allowed, as
recommended.** Both cases are permitted on exactly those terms:

- **Permitted only while the product has zero `RoyaltyRecord`s.** This is the
  load-bearing condition, and it is deliberately a fact in the database rather
  than a judgement someone has to make correctly under pressure. "Has it sold
  yet" is `SELECT count(*) FROM royalty_records WHERE ...` — not an opinion.
- **Admin-only, and audit-logged** like every other back-office mutation.
- **Forbidden absolutely once a single `RoyaltyRecord` exists.** From that
  instant `designerId` is write-once for the life of the product, and the only
  way to change who earns on a design is to retire it.

Both enforcement layers stand: the application check implements the carve-out,
and the **database trigger remains** as the backstop for everything past the
first sale. Write both alongside the migration that introduces
`Product.designerId` — the point at which they are free, per the cost note above.

**Applied in:** §0, §1.1 (cross-reference), §1.2 (scope, in and out), §1.5 (§5.2
FK semantics and the immutability invariant), §1.8 (the `designerId` row is the
payee), §1.9 (**retraction** of the reassignment rationale, plus the added
paragraph on why the payee column survives), §1.12 invariant 6, §1.13 (§8
bullets), §1.16 (§5.1 row), §2, §4.

---

## 4. Migration note

**Verified 2026-08-07, in this repo:**

- `projects/engineering/systems/core/prisma/schema.prisma` (92 lines) contains
  `Product`, `Variant`, `Inventory`, `Actor`, `AuditLog` **and nothing else**.
  There is no `Designer`, no `ProductDesigner`, no `RoyaltyRecord`, no
  `AffiliatePartner`, no `CommissionRecord`, no `Payout`.
- The only two migrations are `20260709000918_init_catalog_audit` and
  `20260709003611_add_fk_indexes`. Neither touches designers or royalty.
- `Order` and `OrderLine` **do not exist yet** — Plan 2 has not been delivered,
  which is exactly the dependency the accepted spec names in its header.
- A repo-wide search for `ProductDesigner`, `splitBps`, `RoyaltyRecord`,
  `designerId` and `designer_id` returns **one** file: `CLAUDE.md`. No code, no
  schema, no fixtures, no tests.

**Therefore:**

1. **This is a spec-only change.** There is no table to drop, no column to
   migrate, no data to backfill, and no code to refactor. Applying this
   amendment costs one editing pass over
   `2026-08-04-designer-royalty-design.md`, plus one over Plan 2 for §3.1.1.
   **The immutability guards in §3.6 are likewise free right now:** with no
   `Product.designerId` column and no product rows carrying one, both the
   application guard and the trigger are written once alongside the migration
   that introduces the column. There is no existing data to validate against and
   no reassignment already in flight to grandfather.
   **`OrderLine.discountCents` is not a migration** in any live sense: `Order`
   and `OrderLine` do not exist yet, so adding the column to Plan 2 changes a
   plan, not a database. It is free **now** and stops being free the moment Plan
   2 ships without it.
2. **No royalty has ever been accrued.** No `RoyaltyRecord` table exists to hold
   one.
3. **No royalty has ever been paid.** No `Payout` table exists, no Stripe
   Connect account is wired, and no designer is onboarded. There is no
   overpayment to recover and no partner to notify.
4. **Nothing partner-facing has gone out** describing the multi-designer terms,
   so no correction to a partner is owed. If that changes before Jack approves
   this, it becomes a partner-comms item and drafts for his sign-off like any
   other.

**The window is the point.** Fixing this before `Order`/`OrderLine` land is free;
fixing it after royalty has accrued against a join table means restating records
that a designer has already been shown. Recommend applying this amendment before
Plan 2 delivery, not after — and the §3.1.1 discount column makes that sequencing
firmer than it was, because that one genuinely must precede the migration rather
than follow it.

**One residual risk:** the accepted spec is marked **Accepted**, so anyone
picking it up cold will implement the join table. Until the amendment is applied,
the cross-reference in §1.1 is the only thing standing between the accepted spec
and a wrong schema. That argues for applying §1.1 first if the rest is going to
sit in review.

---

## 5. Correction needed in `docs/2026-08-04-session-handoff.md`

**Not made here** — this amendment creates no file other than itself, and the
handoff is a dated record of what was decided on 2026-08-04. Recommend the row
be corrected **with the new date shown**, so the history stays legible rather
than looking like the 2026-08-04 session decided something it did not.

**Line 76, "Decisions locked today" table. Currently reads:**

> | **Designer royalty** | Rate defaults on designer, overridable per product · multiple designers via join table with splits · automatic clawback on refund · rate is the designer's own share · basis is line revenue net of line discounts, excluding shipping and tax · no portal at launch · Stripe Connect payouts · clawback nets against next payout |

**Replace with:**

```
| **Designer royalty** | Rate defaults on designer, overridable per product · ~~multiple designers via join table with splits~~ **superseded 2026-08-07: exactly one designer per product, single nullable FK, one line → one royalty record → one payee · that FK is immutable — no designer reassignment** · automatic clawback on refund · rate applies directly to the line basis · basis is line revenue net of line discounts, excluding shipping and tax · no portal at launch · Stripe Connect payouts · clawback nets against next payout |
```

*The strikethrough is deliberate. A dated handoff is a record of a session; a
silent edit makes it look like the multi-designer decision was never taken,
which would confuse anyone reading the 2026-08-04 and 2026-08-07 documents side
by side.*

### Two further documents that carry the stale premise

Found while checking. Neither is edited here; both are someone else's to own.

1. **`docs/superpowers/plans/2026-08-04-consolidation-and-shopify-exit.md`,
   lines 97–98** — open question 2 currently reads:

   > 2. Can a product have **more than one** designer (collaborations)? Decides
   >    whether it is a foreign key or a join table with split percentages.

   This question is now **answered**. Suggested replacement:

   ```
   2. ~~Can a product have more than one designer (collaborations)?~~
      **ANSWERED (Jack, 2026-08-07): no — exactly one creator per product.
      Single nullable FK `Product.designerId`, not a join table.** See
      `projects/engineering/docs/superpowers/specs/2026-08-07-designer-royalty-single-creator-amendment.md`.
   ```

2. **`CLAUDE.md` line 105** — reads *"One line → one `CommissionRecord` → one
   payee"* while the accepted spec uses a separate `RoyaltyRecord` for good
   reasons (§4). **Settled (Jack, 2026-08-07): the table is `RoyaltyRecord`**
   (§3.5), and `CLAUDE.md`'s wording is read as the concept — one
   commission-bearing record per line — not as a table name. **No change to
   `CLAUDE.md` is required**, and none is made here. Recorded so the mismatch is
   a known one rather than a discovered one; if Jack ever does edit that line,
   "one royalty record → one payee" would remove the last snag.

---

## 6. Approval

**Done — the six decisions.** §3.1 through §3.5 were ruled on by Jack on
**2026-08-07**, each as recommended; §3.6 was ruled the same day on Jack's own
initiative. All six are recorded in §3 and propagated into §1 and §2. Nothing
further is needed from Jack on the decisions themselves.

**Done — approval. Jack approved this amendment as a whole on 2026-08-11**, with
the six decisions re-confirmed one at a time and the §3.6 question answered in
the same pass. This document now carries authority.

1. ✅ **Jack approves the amendment as a whole** — 2026-08-11.
2. ⬜ **Sequence the edit with the Engineering Lead**, who owns
   `2026-08-04-designer-royalty-design.md` and applies the changes in §1.
   **This is the only outstanding step**, and until it is done the accepted spec
   still says "Accepted" and still describes a join table. Approval does not
   apply itself.
3. ✅ **The Plan 2 change in §3.1.1** — applied on branch
   `docs/plan2-discount-cents` (PR #13), together with the tax-base ruling that
   adding the column exposed: a discount reduces the taxable base (Jack,
   2026-08-11), so `taxCents` computes on `subtotalCents - discountCents`. That
   ruling is Plan 2's to carry, not this document's; it is noted here only so the
   two are not applied with different arithmetic in mind.
4. ✅ **The §3.6 enforcement recommendation and pre-sale carve-out** — confirmed
   by Jack, 2026-08-11. The carve-out is allowed on the recorded terms; both
   enforcement layers stand. Write them alongside the migration that creates
   `Product.designerId`.

**One clarification arrived with the approval and is recorded in §3.4:** in-house
`own_designed` products with no designer "will never happen". It changes no rule
— and it must **not** be hardened into a `CHECK` constraint. See §3.4.

I have not edited the accepted spec, Plan 2, the session handoff, the
consolidation plan, or `CLAUDE.md`. Every change to those documents is written
out above for someone else to apply.

**Nothing here has moved money.** No royalty has accrued, no payout exists, no
designer is onboarded (§4). When the first one is, the payout drafts for Jack's
approval like every other, with the source order line cited.

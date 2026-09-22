// Settlement import + matching. This is where the money reconciles: Walmart's
// settlement (recon) report against our own order records.
//
// =============================================================================
// UNVERIFIED AGAINST REAL WALMART DATA. Every `discrepancyCents` figure this
// file produces is reasoned from ONE fetched Walmart documentation page
// (https://developer.walmart.com/us-marketplace/docs/recon-report-json), not
// a live Walmart report or sandbox response. Three review rounds on this
// file have each fixed one wrong assumption about the report's shape and
// found another underneath it:
//   - round 1: compared a row's raw amount against a whole-order expected
//     figure, with no shipping reconstruction, no refund netting, no
//     transaction-type gate.
//   - round 2: gated on an INVENTED Transaction Type value (would have
//     silently done nothing in production); then found itemised rows and
//     compared them individually instead of aggregating.
//   - round 3: found the aggregate's dedup key collapsed genuinely distinct
//     rows, and that refunds were wrongly netted into a figure Walmart's own
//     docs say is gross.
// Do NOT treat any `discrepancyCents` / `status: 'discrepant'` this file
// produces as actionable until Task 13's sandbox end-to-end check confirms
// the actual report shape against a real Walmart response. See "LABELLED,
// UNVERIFIED ASSUMPTIONS" further down for the specific open questions this
// round could not settle from documentation alone.
// =============================================================================
//
// Three facts were deliberately handed forward from earlier tasks for THIS
// file to resolve -- see the module-level doc comments below for each:
//   1. `Order.totalCents` excludes SHIPPING (mappers.ts filters to
//      chargeType === 'PRODUCT') -- `reconstructOrderGrossCents`.
//   2. `ChannelEvent.raw` holds the Walmart order payload as received, before
//      that filtering, specifically so this file could reconcile against it
//      -- `reconstructOrderGrossCents` reads it; `expectedNetCents` calls it.
//   3. `Order.status` is a coarse refund flag; the actual refunded amount
//      lives only in `ChannelEvent.raw` (return_created). Round 3 (finding
//      B2) removed refund netting from the Sale-row comparison entirely --
//      Walmart's docs describe a `Sale` row as gross, so refunds reconcile
//      as their own rows, not as a deduction from a Sale row's expected
//      figure. Fact 3 itself (where the refunded amount lives) is still
//      true and still needed if refund-row reconciliation is ever built;
//      see "LABELLED, UNVERIFIED ASSUMPTIONS".
import { Prisma } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { ChannelError } from './orders.ingest.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toCents } from './mappers.js'

type Db = Prisma.TransactionClient

export interface SettlementRow {
  externalOrderId: string
  amountCents: number
  feeCents: number
  currency: string
  // Walmart's recon report "Transaction Type" column -- documented values
  // are `Sale` (a customer order/payment) and `PaymentSummary` (settlement/
  // payout activity): see SALE_TRANSACTION_TYPE's doc comment for the
  // citation. Beyond the brief's original interface: needed as a
  // first-class field, not just something buried in `raw`, for the
  // transaction-type gate and the ledger key below -- see
  // reconstructOrderGrossCents/expectedNetCents' doc comments and
  // ChannelSettlement.transactionType in schema.prisma.
  transactionType: string
  // Review round 3 (finding B1): Walmart's own ledger identifiers, read as
  // first-class fields (not left buried in `raw`) so `computeLedgerKey` can
  // key a row by IDENTITY instead of by value. Empty string when the
  // report doesn't carry the column (or it's blank) -- never undefined, so
  // `computeLedgerKey`'s fallback composite always has a stable shape.
  transactionKey: string
  purchaseOrderLine: string
  amountType: string
  raw: Record<string, string>
}

/**
 * Splits each data line on bare commas -- no quoted-field handling. Brief-
 * verbatim (this is the brief's Step 3 code unchanged). Known, disclosed
 * limitation: a quoted field containing a comma (e.g. a `Transaction Type`
 * or free-text column Walmart quotes because it embeds one) shifts every
 * column after it, and a non-numeric string landing in `Amount` or
 * `Commission Amount` parses to `NaN` cents -- silently wrong money, not a
 * thrown error, at THIS function. `importSettlementRows` wraps the whole
 * import in one transaction specifically so a `NaN` reaching a `create()`
 * call rolls back the entire report rather than committing everything before
 * it and silently leaving the report half-imported -- see that function's
 * doc comment. This function itself is not changed to guard against it: the
 * fix belongs in the CSV parser (quoted-field support) if Walmart's real
 * report ever needs it, which is unverified pending Task 13.
 *
 * Also unverified pending Task 13: the recon report's actual wire format
 * appears to be JSON (`{ reportData: [...], nextOffset, totalRecords,
 * description }`), not this CSV shape at all, per the one documentation page
 * fetched during review round 2/3. This function is left as specified by
 * the brief; if the real report is JSON, this whole parsing layer -- not
 * just this function -- needs replacing, per the brief's own scoping
 * ("Actual sandbox response format... verified in Task 13; any correction
 * lands here and in the client only").
 */
export function parseSettlementCsv(csv: string): SettlementRow[] {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/)
  const headers = headerLine.split(',').map((h) => h.trim())
  const rows: SettlementRow[] = []
  for (const line of lines) {
    const cells = line.split(',')
    const raw = Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))
    const po = raw['Purchase Order #']
    if (!po) continue
    rows.push({
      externalOrderId: po,
      amountCents: toCents(Number(raw['Amount'] || 0)),
      feeCents: toCents(Number(raw['Commission Amount'] || 0)),
      currency: raw['Currency'] || 'USD',
      transactionType: raw['Transaction Type'] || '',
      transactionKey: raw['Transaction Key'] || '',
      purchaseOrderLine: raw['Purchase Order line #'] || '',
      amountType: raw['Amount Type'] || '',
      raw,
    })
  }
  return rows
}

// --------------------------------------------------------------------------
// Reconciliation arithmetic
// --------------------------------------------------------------------------

/**
 * Walmart's recon report emits more than one transaction row per PO --
 * in practice a Sale row and a later Refund row both arrive for the SAME
 * PO, and (see `saleAmountSumByOrder` below) a single sale itself arrives
 * as more than one `Sale`-type row. Comparing any row's `amountCents`
 * against the order's expected gross only makes sense for the row(s) that
 * represent the actual sale settlement -- comparing an adjustment/refund
 * row the same way manufactures a large false discrepancy on both sides
 * (the sale total looks overpaid, the refund row looks like a near-total
 * shortfall), and neither is real.
 *
 * VERIFIED against Walmart's published documentation (review round 2 --
 * round 1's `'PaymentWithdrawn'` was an invented placeholder from the
 * brief's own fixture, not a real Walmart value; it appears nowhere in the
 * docs, and would have made every real Sale row fail this gate, silently
 * skipping ALL discrepancy computation in production while every test
 * stayed green, because the fixture invented the same value it was checked
 * against): https://developer.walmart.com/us-marketplace/docs/recon-report-json
 * documents `"Transaction Type": "Sale"` (customer orders/payments) and
 * `"Transaction Type": "PaymentSummary"` (settlement/payout activity) as
 * the two values shown in its example `reportData` records. `'Sale'` is
 * the one that represents a real sale settlement.
 */
const SALE_TRANSACTION_TYPE = 'Sale'

/**
 * Fact 1 + fact 2, resolved: the gross order value Walmart itself computed,
 * reconstructed straight from the order_created ChannelEvent.raw payload --
 * the exact same shape `toCanonicalOrder` (mappers.ts) reads, but summing
 * EVERY charge on every line (not just PRODUCT, the way `toCanonicalOrder`
 * does when it builds `Order.totalCents`). That filtering is what makes
 * `settlement.amountCents === order.totalCents` the wrong comparison
 * whenever an order had a SHIPPING charge; this function sums whatever
 * charge types are actually present -- PRODUCT, SHIPPING, or any other type
 * Walmart's payload carries -- rather than naming only the two known today,
 * so an unfamiliar future charge type is still included in the true gross
 * instead of silently dropped the way `toCanonicalOrder` drops SHIPPING.
 *
 * Applies the same "charges/tax are per unit" convention `toCanonicalOrder`
 * already uses for PRODUCT (see its `lineTaxCents` comment) to every charge
 * type on the line, for consistency with the one place in this codebase that
 * already interprets this payload shape -- not a new assumption invented
 * here. Real sandbox behaviour for SHIPPING specifically is unverified
 * (Task 13 verifies the actual response shape); if SHIPPING turns out to be
 * a flat per-line amount rather than per-unit, this is the one function that
 * needs correcting, isolated the same way mappers.ts isolates Walmart's
 * shape from the rest of the codebase.
 *
 * Returns `null` -- never `0`, never a guess -- when the payload doesn't have
 * the shape this needs (missing/malformed orderLines, a non-numeric charge).
 * `expectedNetCents` treats that the same as "no order_created event at
 * all": nothing to compare against, rather than falling back to a figure
 * (`Order.totalCents`) this codebase already knows can be short by exactly
 * a dropped SHIPPING charge -- see `expectedNetCents`'s comment (review
 * round 1, issue 3: the old fallback manufactured a discrepancy equal to
 * shipping for every pre-Task-5 order with no raw payload on file).
 */
export function reconstructOrderGrossCents(raw: unknown): number | null {
  const lines = (raw as any)?.orderLines?.orderLine
  if (!Array.isArray(lines) || lines.length === 0) return null
  let totalCents = 0
  for (const line of lines) {
    const qty = Number(line?.orderLineQuantity?.amount)
    const charges = line?.charges?.charge
    if (!Number.isInteger(qty) || qty <= 0 || !Array.isArray(charges) || charges.length === 0) return null
    for (const charge of charges) {
      const amount = charge?.chargeAmount?.amount
      if (typeof amount !== 'number') return null
      totalCents += toCents(amount) * qty
      const taxAmount = charge?.tax?.taxAmount?.amount
      if (taxAmount !== undefined) {
        if (typeof taxAmount !== 'number') return null
        totalCents += toCents(taxAmount) * qty
      }
    }
  }
  return totalCents
}

/**
 * The figure a `Sale`-type settlement row's aggregate `amountCents` (see
 * `saleAmountSumByOrder`) is checked against: the order's GROSS value,
 * reconstructed from its order_created ChannelEvent.raw (fact 1 + fact 2,
 * `reconstructOrderGrossCents` above). Nothing else.
 *
 * Review round 3, finding B2: this function PREVIOUSLY subtracted every
 * refund recorded on or before the report date (a `sumRefundedCents` helper,
 * removed in this round). That was wrong: this file's own module doc
 * (and Walmart's documented `Sale`/`PaymentSummary` transaction-type split)
 * says a `Sale` row is a gross settlement figure, and a refund is its own,
 * separate row -- not a deduction baked into a later Sale row's amount.
 * Netting a refund out of the expected gross meant any `Sale` row dated
 * after an already-ingested refund was compared against a net-of-refund
 * figure it was never actually net of, producing a phantom OVERPAYMENT and
 * a false `'discrepant'` flag -- exactly the kind of manufactured
 * discrepancy this task exists to prevent, now on the opposite sign from
 * round 1's original shipping bug. Refund reconciliation (comparing a
 * refund-shaped row, if one exists, against the return's own recorded
 * amount) is NOT built here -- Walmart's recon report doesn't document how
 * a refund row is shaped, so building that comparison now would be
 * guessing at a report shape the same way the last three rounds did. See
 * "LABELLED, UNVERIFIED ASSUMPTIONS" below.
 *
 * Returns `null` -- REFUSES to compare -- when there is no order_created
 * ChannelEvent on file, or its `raw` is null, or `reconstructOrderGrossCents`
 * can't parse it (review round 1, issue 3, overruling this file's original
 * decision to fall back to `Order.totalCents`): `ChannelEvent.raw` is
 * nullable specifically because it predates Task 5's migration, so every
 * Walmart order ingested before that migration has no raw payload on file
 * and would silently take that fallback -- comparing against a figure this
 * codebase already knows excludes SHIPPING is the "never estimate a figure"
 * rule in another costume, just with the estimate coming from our own
 * database instead of an invented rate. `null` here is the honest answer:
 * nothing comparable exists, so nothing is compared. The caller leaves
 * `discrepancyCents` null and `status: 'unreconciled'` (review round 3,
 * finding B3 -- an order genuinely was found, but the amount was NEVER
 * COMPARED, which is not the same thing as a verified match).
 *
 * Deliberately does NOT subtract `feeCents`/commission from this figure --
 * see `discrepancyCents`'s schema comment for why: there is no
 * independently-sourced expected commission rate anywhere in this codebase
 * to check Walmart's stated commission against, and inventing one would be
 * exactly the "estimate a figure" this project's money rule forbids. This
 * function reconstructs REVENUE, not net-of-commission payout.
 */
async function expectedNetCents(db: Db, externalOrderId: string): Promise<number | null> {
  const event = await db.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: externalOrderId, eventType: 'order_created' } },
  })
  if (event?.raw == null) return null
  return reconstructOrderGrossCents(event.raw)
}

function truncateToUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Review round 3, finding B1 (Critical), overruling round 1's value-based
 * idempotency key: `(externalOrderId, reportDate, transactionType,
 * amountCents, feeCents)` has no way to tell apart two GENUINELY DIFFERENT
 * rows that happen to carry the same amount and fee -- a two-line order of
 * the same $49.99 SKU (Walmart splits quantity into separate lines), or a
 * Shipping and a Tax line that both happen to carry `feeCents: 0`. The old
 * key found the FIRST such row via `findFirst` and silently treated the
 * SECOND as a re-delivery of it, skipping it entirely -- while the in-memory
 * aggregate (`saleAmountSumByOrder`, computed from the input `rows`, not
 * from what actually got persisted) still counted the dropped row's amount.
 * Result: the stored `discrepancyCents` said the group balanced, but the
 * PERSISTED rows for that PO summed to less than that -- the ledger no
 * longer reproduced its own reconciliation.
 *
 * Fix: key by Walmart's own `Transaction Key` where the report provides one
 * -- an identifier, not a value, so two rows can never collide just because
 * their amounts match. Falls back to `(externalOrderId, Purchase Order
 * line #, Amount Type, reportDate)` when no Transaction Key is present:
 * still an IDENTITY (which line, what kind of amount, which report), not a
 * value. A row with an empty `transactionKey` AND an empty
 * `purchaseOrderLine`/`amountType` degrades to keying on
 * `(externalOrderId, '', '', reportDate)` alone -- no worse than round 1's
 * key for that specific degenerate case, and every other case is strictly
 * safer.
 *
 * This key is INTENTIONALLY no longer value-sensitive: a row with the same
 * identity but a different `amountCents`/`feeCents` on a later pull is now
 * treated as a duplicate (found, skipped), not a correction. That is a
 * deliberate reversal of round 1's stance ("a human should see both rows").
 * Walmart's own `Transaction Key` is presumably a stable ledger-entry
 * identifier -- a real correction should arrive as a NEW entry (its own
 * key), the way a reversing entry works in any ledger, not as a silent
 * value-mutation of an existing one under the same key. Unverified against
 * real Walmart data like everything else in this file; flagged, not
 * guessed past.
 */
function computeLedgerKey(row: SettlementRow, reportDate: Date): string {
  if (row.transactionKey) return row.transactionKey
  return [row.externalOrderId, row.purchaseOrderLine, row.amountType, reportDate.toISOString().slice(0, 10)].join('|')
}

/**
 * True for a Prisma unique-constraint violation -- mirrors
 * `isConcurrentDeliveryRace` in orders.ingest.ts / returns.service.ts
 * exactly, same failure mode one file over: two truly concurrent imports of
 * the same report (a scheduler double-firing, or a manual re-run racing a
 * scheduled one) can both pass a duplicate-row read before either commits.
 */
function isConcurrentImportRace(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------

/**
 * Idempotency key: `computeLedgerKey` above (review round 3, finding B1),
 * enforced by a DB-level `@@unique` constraint on `ChannelSettlement.ledgerKey`
 * (schema.prisma), not app-level `findFirst`-then-`create` alone --
 * `findFirst`-then-`create` is non-atomic under two genuinely concurrent
 * imports of the same report (both can pass the `findFirst` read before
 * either commits). The `findFirst` check below still runs first, as a cheap
 * fast path that avoids a doomed `create` in the common sequential case;
 * the unique constraint is the actual guarantee.
 *
 * The whole import runs inside ONE `prisma.$transaction` (review round 1)
 * for two reasons: (a) `recordAudit` below must commit atomically with
 * everything it's reporting on, matching every other money-affecting write
 * in this codebase; (b) a malformed row that makes a `create()` throw (e.g.
 * `NaN` cents from `parseSettlementCsv`'s comma-split limitation, or a
 * positive-commission `Sale` row -- see the fee-sign guard below) rolls back
 * the ENTIRE report import rather than committing everything before it and
 * silently leaving the report half-imported. A concurrent-import race
 * (`isConcurrentImportRace`) rolls back the whole attempt the same way
 * `ingestWalmartOrder` does, and is retried exactly once: the retry's own
 * `findFirst` checks will correctly skip everything the winning transaction
 * already committed, so it is a safe, idempotent re-run, not a
 * double-import.
 *
 * Review round 3, finding B7 (item 10): a `Sale` row is expected to carry a
 * commission as a DEDUCTION (`feeCents <= 0`, matching how the CSV's
 * `Commission Amount` column has always been signed in every fixture and
 * every documented sign convention this file relies on). A positive
 * `feeCents` on a `Sale` row is not a value this file has any documented
 * interpretation for, and averaging/ignoring it would let it "pass
 * silently" -- exactly what the review flagged. Throws `ChannelError`
 * (`invalid_fee_sign`), which aborts the whole transaction the same way a
 * malformed row does, rather than committing a row this file cannot
 * meaningfully reconcile.
 *
 * For each non-duplicate, valid row: create one `ChannelSettlement`,
 * storing `netCents = amountCents + feeCents` unconditionally (pure
 * arithmetic on the row itself, no order needed). If an `Order` with that
 * `externalOrderId` exists, link `orderId`; if the row's `transactionType`
 * is the sale type (`SALE_TRANSACTION_TYPE`) AND `expectedNetCents` can
 * compute a real figure, set `discrepancyCents` from the order-level
 * aggregate (`saleAmountSumByOrder` below). Status (review round 3, finding
 * B3, overruling rounds 1-2's two-way split):
 *   - no order found                                  -> `'unmatched'`
 *   - order found, no comparison was possible          -> `'unreconciled'`
 *   - order found, compared, discrepancyCents !== 0    -> `'discrepant'`
 *   - order found, compared, discrepancyCents === 0    -> `'matched'`
 * `'matched'` now means ONLY "compared, and exactly right" -- rounds 1-2
 * filed every refused/non-sale/never-checked row as `'matched'` too,
 * indistinguishable from a verified zero.
 *
 * A summary audit row (`walmart_settlement_imported`) is written once per
 * call, inside the same transaction, recording `reportDate`, the input row
 * count, and the final `imported`/`matched`/`unmatched`/`discrepant`/
 * `unreconciled` counts -- these are financial records being created; every
 * other money-affecting write in this codebase leaves an audit trail.
 */
export async function importSettlementRows(
  reportDate: Date,
  rows: SettlementRow[],
): Promise<{ imported: number; matched: number; unmatched: number }> {
  return importSettlementRowsAttempt(reportDate, rows, false)
}

/**
 * Review round 2 + round 3 (finding B4, STOPPED, not fixed -- see the task
 * report): Walmart's recon report carries an `"Amount Type"` column
 * (documented example: `"Amount Type": "Product Price"`) alongside
 * `"Transaction Type"` -- strong evidence a single sale settlement arrives
 * as SEVERAL `Sale`-type rows per PO (product/shipping/tax), not one row
 * carrying the whole order total. Comparing any one of those rows'
 * `amountCents` against the whole order's expected gross compares a
 * fragment against the whole and manufactures a false discrepancy on every
 * itemised sale.
 *
 * Fix (round 2): sum every `Sale`-type row's `amountCents` per
 * `externalOrderId`, **within this call's own `rows` array**, before
 * comparing, and write the resulting `discrepancyCents` to every `Sale` row
 * in the group -- they share one order-level answer, not N independent
 * ones.
 *
 * KNOWN LIMITATION, not fixed this round (finding B4): this sum is scoped
 * to ONE call's own rows and is NEVER RE-COMPUTED once a row is persisted.
 * If a report arrives itemised across more than one import call for the
 * same order (e.g. a partial pull stamps the Product row `discrepant`
 * against a gross it can't yet see the Shipping/Tax rows for; a later,
 * complete pull for the same PO adds those siblings as NEW rows, correctly
 * keyed and not colliding with the first pull's row now that B1 keys by
 * identity) -- the FIRST pull's already-persisted row keeps its stale,
 * now-wrong `discrepancyCents` forever. The group ends up self-contradictory:
 * old row reads `discrepant`, new siblings read `matched`, and no single
 * row (or query) tells a human "the group, as it now stands, reconciles."
 *
 * The correct fix -- summing every PERSISTED `Sale` row for the PO with
 * `reportDate` up to and including this call's `reportDate` (safe now that
 * B1 makes every row a unique ledger entry, so no double-counting), then
 * RE-STAMPING every one of those rows (old and new) with the freshly
 * computed consistent result -- requires restructuring this function from a
 * single insert-per-row pass into an insert-then-reconcile two-phase
 * process: insert this call's new rows first (still keyed/deduped as
 * today), then, for every `externalOrderId` touched by a new `Sale` row in
 * this call, re-query ALL persisted `Sale` rows for that PO up to
 * `reportDate` and `updateMany` their `discrepancyCents`/`status` to the
 * newly consistent answer. That is a real behavioural and structural
 * change (a write pattern this file has never done -- updating rows a
 * PRIOR call already committed), not a contained edit to this loop, so per
 * this round's explicit instruction it is being reported, not guessed at
 * under time pressure that produced the last three rounds' bugs. See the
 * task report for the recommended design and the assumption it still rests
 * on (that one report pull is the natural unit to reconcile within, even
 * once re-stamping crosses calls).
 */
async function importSettlementRowsAttempt(
  reportDate: Date,
  rows: SettlementRow[],
  retried: boolean,
): Promise<{ imported: number; matched: number; unmatched: number }> {
  const normalizedDate = truncateToUtcDate(reportDate)
  let imported = 0
  let matched = 0
  let unmatched = 0
  let discrepant = 0
  let unreconciled = 0

  const saleAmountSumByOrder = new Map<string, number>()
  for (const row of rows) {
    if (row.transactionType === SALE_TRANSACTION_TYPE) {
      saleAmountSumByOrder.set(row.externalOrderId, (saleAmountSumByOrder.get(row.externalOrderId) ?? 0) + row.amountCents)
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        // Review round 3, finding B7/item 10: a Sale row's commission is
        // documented (and every fixture in this file) as a deduction --
        // feeCents <= 0. A positive value on a Sale row is not a shape this
        // file has any interpretation for; fail loudly rather than let it
        // pass silently into a discrepancy figure that would be wrong for
        // reasons nobody could see from the stored data alone.
        if (row.transactionType === SALE_TRANSACTION_TYPE && row.feeCents > 0) {
          throw new ChannelError(
            'invalid_fee_sign',
            `Sale row for ${row.externalOrderId} carries a positive commission (feeCents=${row.feeCents}); commission must be <= 0`,
          )
        }

        const ledgerKey = computeLedgerKey(row, normalizedDate)
        const dupe = await tx.channelSettlement.findFirst({ where: { ledgerKey } })
        if (dupe) continue

        const order = await tx.order.findUnique({
          where: { externalOrderId: row.externalOrderId },
          select: { id: true, externalOrderId: true },
        })

        let discrepancyCents: number | null = null
        let compared = false
        if (order && order.externalOrderId && row.transactionType === SALE_TRANSACTION_TYPE) {
          const expected = await expectedNetCents(tx, order.externalOrderId)
          if (expected !== null) {
            compared = true
            // The order-level aggregate (see saleAmountSumByOrder's doc
            // comment above `importSettlementRowsAttempt`), not this row's
            // own amountCents alone -- an itemised row's individual amount
            // is not comparable to the whole order's expected gross.
            const groupAmountCents = saleAmountSumByOrder.get(row.externalOrderId)!
            discrepancyCents = groupAmountCents - expected
          }
        }

        let status: 'matched' | 'unmatched' | 'discrepant' | 'unreconciled'
        if (!order) status = 'unmatched'
        else if (!compared) status = 'unreconciled'
        else if (discrepancyCents !== 0) status = 'discrepant'
        else status = 'matched'

        await tx.channelSettlement.create({
          data: {
            reportDate: normalizedDate,
            externalOrderId: row.externalOrderId,
            transactionType: row.transactionType,
            amountCents: row.amountCents,
            feeCents: row.feeCents,
            netCents: row.amountCents + row.feeCents,
            currency: row.currency,
            orderId: order?.id,
            status,
            discrepancyCents,
            ledgerKey,
            raw: row.raw as Prisma.InputJsonValue,
          },
        })
        imported++
        if (order) matched++
        else unmatched++
        if (status === 'discrepant') discrepant++
        if (status === 'unreconciled') unreconciled++
      }

      await recordAudit(
        {
          actorId: 'system',
          action: 'walmart_settlement_imported',
          // "source" here is the report endpoint this data structurally
          // comes from -- importSettlementRows itself has no webhook/poll
          // distinction the way order/return ingestion does, since a
          // settlement report is only ever pulled, never pushed.
          target: `settlement_report:${normalizedDate.toISOString().slice(0, 10)}`,
          after: {
            reportDate: normalizedDate.toISOString().slice(0, 10),
            source: 'walmart_reconreport',
            rowCount: rows.length,
            imported,
            matched,
            unmatched,
            discrepant,
            unreconciled,
          },
        },
        tx,
      )
    })
  } catch (e) {
    if (!isConcurrentImportRace(e) || retried) throw e
    return importSettlementRowsAttempt(reportDate, rows, true)
  }

  return { imported, matched, unmatched }
}

/**
 * `GET /v3/report/reconreport/reconFile` with query `{ reportDate }`
 * (`YYYY-MM-DD`). Actual sandbox response format (possibly zipped) is
 * unverified until Task 13 -- if it turns out not to be a bare CSV string or
 * `{ csv: string }`, the correction lands here and in the client only, per
 * the brief. See the file-level warning at the top: the fetched
 * documentation page's example response is JSON, not CSV, so this function's
 * whole premise is itself one of the unverified assumptions Task 13 needs to
 * check.
 */
export async function fetchAndImportSettlement(
  reportDate: Date,
  client: WalmartClient = getWalmartClient(),
): Promise<{ imported: number; matched: number; unmatched: number }> {
  const res = await client.request('GET', '/v3/report/reconreport/reconFile', {
    query: { reportDate: reportDate.toISOString().slice(0, 10) },
  })
  const csv = typeof res === 'string' ? res : (res as any)?.csv
  if (typeof csv !== 'string') throw new Error('walmart settlement: unexpected report response shape')
  return importSettlementRows(reportDate, parseSettlementCsv(csv))
}

// =============================================================================
// LABELLED, UNVERIFIED ASSUMPTIONS (review round 3) -- not guessed at further,
// recorded explicitly per the instruction to label rather than assume:
//
// - COMMISSION ROWS. Unconfirmed recollection (not a documentation citation):
//   Walmart's `Amount Type` may include commission lines (e.g. "Commission
//   on Product") carried ON `Sale` rows as negative amounts. If real, this
//   file's `saleAmountSumByOrder` aggregate -- which sums every `Sale`-type
//   row's `amountCents` regardless of `Amount Type` -- would include those
//   commission lines in the "gross" side of the comparison, and EVERY order
//   would show a false shortfall equal to its own commission. Not fixed:
//   there is no documentation confirming or shaping this, and guessing at
//   an `Amount Type` exclusion list is exactly the pattern that produced
//   three rounds of bugs already.
// - WIRE FORMAT. The one fetched documentation example is a JSON response
//   (`{ reportData: [...], nextOffset, totalRecords, description }`), not
//   the CSV `parseSettlementCsv`/`fetchAndImportSettlement` assume. Per the
//   brief, this is explicitly Task 13's to verify and correct.
// - AMOUNT TYPE ENUMERATION. Only `"Product Price"` is documented by
//   example. `Shipping` and `Tax` (used in this file's itemisation test)
//   are inferred by analogy to other marketplace settlement formats, not
//   confirmed by Walmart's own documentation.
// - REFUND-TIME BOUNDARY. Not currently load-bearing (round 3 removed
//   refund netting from the Sale comparison entirely -- see expectedNetCents'
//   doc comment), but preserved here as a fact for whoever eventually builds
//   refund-ROW reconciliation: `ChannelEvent.processedAt` is this codebase's
//   own ingestion timestamp, not Walmart's own refund-issued timestamp, and
//   Walmart's report "day" boundary is not confirmed to be UTC.
// =============================================================================

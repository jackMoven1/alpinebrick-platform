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
//   - round 4: found the round-3 identity key could still collapse distinct
//     rows (no transaction type in it; an all-empty identity degrading to
//     PO+date), and that a well-formed-but-odd row blocked a whole day.
// Do NOT treat any `discrepancyCents` / `status: 'discrepant'` this file
// produces as actionable until Task 13's sandbox end-to-end check confirms
// the actual report shape against a real Walmart response. That status is
// also carried IN THE DATA (round 4, finding 5): every row this file writes
// has `reconciliation_model = 'unverified'`, and every import's audit row has
// `reconciliationModel: 'unverified'` -- see RECONCILIATION_MODEL. See
// "LABELLED, UNVERIFIED ASSUMPTIONS" further down for the specific open
// questions documentation alone could not settle, and the BLOCKER FOR TASK
// 13 note (finding B4) above `importSettlementRowsAttempt`.
// =============================================================================
//
// Three facts were deliberately handed forward from earlier tasks for THIS
// file to resolve -- see the module-level doc comments below for each:
//   1. `Order.totalCents` excludes SHIPPING (mappers.ts filters to
//      chargeType === 'PRODUCT') -- `reconstructOrderGrossCents`.
//   2. `ChannelEvent.raw` holds the Walmart order payload as received, before
//      that filtering, specifically so this file could reconcile against it
//      -- `reconstructOrderGrossCents` reads it; `expectedGrossCents` calls it.
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
import { createHash } from 'node:crypto'
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
  // reconstructOrderGrossCents/expectedGrossCents' doc comments and
  // ChannelSettlement.transactionType in schema.prisma.
  transactionType: string
  // Review round 3 (finding B1): Walmart's own ledger identifiers, read as
  // first-class fields (not left buried in `raw`) so `baseLedgerKey` can
  // key a row by IDENTITY instead of by value. Empty string when the
  // report doesn't carry the column (or it's blank) -- never undefined, so
  // `baseLedgerKey` always sees a stable shape.
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
 * PO, and (see `importSettlementRowsAttempt` below) a single sale itself arrives
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
 * `expectedGrossCents` treats that the same as "no order_created event at
 * all": nothing to compare against, rather than falling back to a figure
 * (`Order.totalCents`) this codebase already knows can be short by exactly
 * a dropped SHIPPING charge -- see `expectedGrossCents`'s comment (review
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
 * The figure a `Sale`-type settlement group's summed `amountCents` is checked
 * against: the order's GROSS value, reconstructed from its order_created
 * ChannelEvent.raw (fact 1 + fact 2, `reconstructOrderGrossCents` above).
 * Nothing else. (Named `expectedNetCents` until review round 4 -- it has
 * returned gross, not net, since round 3 removed refund netting.)
 *
 * Review round 3, finding B2: this function PREVIOUSLY subtracted every
 * refund recorded on or before the report date (a `sumRefundedCents` helper,
 * removed in that round). That was wrong: Walmart's documented
 * `Sale`/`PaymentSummary` transaction-type split says a `Sale` row is a gross
 * settlement figure, and a refund is its own, separate row -- not a
 * deduction baked into a later Sale row's amount. Netting a refund out of
 * the expected gross meant any `Sale` row whose refund was already on file
 * by the report date was compared against a net-of-refund figure it was
 * never actually net of: a phantom OVERPAYMENT and a false `'discrepant'`
 * flag. Refund reconciliation (comparing a refund-shaped row, if one exists,
 * against the return's own recorded amount) is NOT built here -- Walmart's
 * recon report doesn't document how a refund row is shaped. See "LABELLED,
 * UNVERIFIED ASSUMPTIONS" below.
 *
 * Returns `null` -- REFUSES to compare -- when there is no order_created
 * ChannelEvent on file, or its `raw` is null, or `reconstructOrderGrossCents`
 * can't parse it (review round 1, issue 3): `ChannelEvent.raw` is nullable
 * because it predates Task 5's migration, and falling back to
 * `Order.totalCents` -- a figure this codebase knows excludes SHIPPING --
 * would be estimating a figure. The caller leaves `discrepancyCents` null
 * and `status: 'unreconciled'`.
 *
 * Deliberately does NOT subtract `feeCents`/commission: there is no
 * independently-sourced expected commission rate anywhere in this codebase
 * to check Walmart's stated commission against. This function reconstructs
 * REVENUE, not net-of-commission payout.
 */
async function expectedGrossCents(db: Db, externalOrderId: string): Promise<number | null> {
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
 * Stamped on every `ChannelSettlement` row (`reconciliationModel` column) and
 * on every import's audit row, so the provisional status of `status` /
 * `discrepancyCents` is visible to anyone reading DATA, not just to a
 * developer reading this file (review round 4, finding 5). Task 13's sandbox
 * check is what may change this value; rows written before that keep
 * `'unverified'`, which is the correct provenance for them.
 */
export const RECONCILIATION_MODEL = 'unverified'

/**
 * Why a row (and, for a `Sale` row, its whole order group -- see
 * `importSettlementRowsAttempt`) was persisted but deliberately NOT compared.
 * Recorded in the import's audit row.
 *   - `no_identity`: no Transaction Key, no Purchase Order line #, no Amount
 *     Type. There is nothing to tell this row apart from a sibling, so it is
 *     keyed on a hash of the raw row and never deduped against another row.
 *   - `identity_collision`: this row's key was already used by an earlier
 *     row IN THE SAME IMPORT CALL -- the uniqueness assumption below was
 *     violated. Persisted under a suffixed key rather than dropped.
 *   - `positive_commission`: a `Sale` row with `feeCents > 0` (finding 4) --
 *     well-formed data this file has no interpretation for (a commission
 *     reversal is plausible), not corrupt parsing.
 */
type AnomalyReason = 'no_identity' | 'identity_collision' | 'positive_commission'

/**
 * Review round 3 (B1) replaced round 1's VALUE key with an IDENTITY key.
 * Review round 4 (finding 1) closed the ways that identity key could still
 * collapse genuinely distinct rows -- each of which silently skipped the
 * second row while the in-memory aggregate still counted it, i.e. the
 * original B1 defect:
 *   (a) `transactionType` was not in the key: a `Sale` and a
 *       `PaymentSummary`/refund row sharing PO, line # and Amount Type on one
 *       day collided. It is now in every identity key.
 *   (b) With no Transaction Key, no line # and no Amount Type, the key
 *       degraded to `PO||date`, collapsing EVERY row for that PO on that day
 *       into one -- WORSE than round 1's value key (which at least told rows
 *       apart by type, amount and fee), not "no worse" as the round-3 comment
 *       claimed. Such a row now has no identity key at all: it is keyed on a
 *       hash of its raw row and is never compared.
 *   (c) Every in-batch key reuse is now persisted under a suffixed key and
 *       flagged, not dropped -- nothing a report delivers is lost.
 *
 * Key forms (the prefixes keep the three spaces disjoint):
 *   - `tk:<Transaction Key>|<type>|<line #>|<Amount Type>` when a Transaction
 *     Key is present. Not the bare Transaction Key (round 3's choice):
 *     whether Walmart gives each ITEMISED row its own key, or one key per
 *     transaction shared by its Product Price / Shipping / Tax rows, is
 *     undocumented. Composing the other identity fields in is harmless if
 *     keys are per-row, and prevents collapsing an itemised sale if they are
 *     per-transaction. No report date: a Transaction Key is assumed stable
 *     across report pulls.
 *   - `po:<PO>|<type>|<line #>|<Amount Type>|<report date>` when there is no
 *     Transaction Key but at least a line # or an Amount Type.
 *   - `raw:<report date>|<sha256 of the raw row, keys sorted>` when there is
 *     no identity at all.
 * The Nth (N >= 1) reuse of the same key within ONE call becomes `<key>#N`,
 * flagged `identity_collision`.
 *
 * UNIQUENESS ASSUMPTION (unverified against real Walmart data): within one
 * report, no two DISTINCT rows share Transaction Key + Transaction Type +
 * line # + Amount Type (or, with no Transaction Key, PO + Transaction Type +
 * line # + Amount Type + report date). If that is ever false it is no longer
 * silent: the second row is still persisted (suffixed), its order group is
 * `'unreconciled'`, and the collision is listed in the audit row. What
 * remains silent is ACROSS calls: a row whose key an earlier call already
 * persisted is skipped as a re-delivery -- the idempotency this key exists
 * for. The `#N` suffix relies on a re-delivered report listing colliding rows
 * in the same order.
 *
 * The key is intentionally NOT value-sensitive: a row with the same identity
 * but a different amount on a later pull is a duplicate (skipped), not a
 * correction -- a real correction is presumed to arrive as a new ledger entry
 * with its own identity. Unverified, like everything else in this file.
 */
function baseLedgerKey(row: SettlementRow, reportDay: string): { key: string; hasIdentity: boolean } {
  if (row.transactionKey) {
    return { key: `tk:${[row.transactionKey, row.transactionType, row.purchaseOrderLine, row.amountType].join('|')}`, hasIdentity: true }
  }
  if (row.purchaseOrderLine || row.amountType) {
    return {
      key: `po:${[row.externalOrderId, row.transactionType, row.purchaseOrderLine, row.amountType, reportDay].join('|')}`,
      hasIdentity: true,
    }
  }
  const canonicalRaw = JSON.stringify(Object.keys(row.raw).sort().map((k) => [k, row.raw[k]]))
  return { key: `raw:${reportDay}|${createHash('sha256').update(canonicalRaw).digest('hex')}`, hasIdentity: false }
}

/**
 * True for a Prisma unique-constraint violation -- mirrors
 * `isConcurrentDeliveryRace` in orders.ingest.ts / returns.service.ts
 * exactly, same failure mode one file over: two truly concurrent imports of
 * the same report can both pass a duplicate-row read before either commits.
 */
function isConcurrentImportRace(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------

export interface SettlementImportResult {
  imported: number
  // Rows linked to an existing Order by externalOrderId -- whether or not the
  // amount was ever compared. Review round 4, finding 3: this was called
  // `matched`, which is also a `status` value meaning "compared and exactly
  // right"; one name meant two things. `linked + unmatched === imported`.
  // Per-status counts are in the audit row's `byStatus`.
  linked: number
  unmatched: number
}

/**
 * Idempotency: `baseLedgerKey` above, enforced by a DB-level `@unique`
 * constraint on `ChannelSettlement.ledgerKey`; the `findFirst` check is only
 * a fast path. The whole import runs inside ONE `prisma.$transaction` so
 * `recordAudit` commits atomically with the rows it reports on, and a
 * CORRUPT row (e.g. `NaN` cents from `parseSettlementCsv`'s comma-split
 * limitation, which makes `create()` throw) rolls back the entire report
 * rather than leaving it half-imported. A concurrent-import race is retried
 * exactly once.
 *
 * Well-formed rows this file does not understand do NOT throw (review round
 * 4, finding 4 -- round 3 threw on a positive-commission `Sale` row, which
 * rolled back every other order's reconciliation for that day, on every
 * retry, and left no audit trail). They are persisted, `'unreconciled'`, and
 * listed in the audit row's `anomalies`.
 *
 * Status:
 *   - no order found                                        -> `'unmatched'`
 *   - order found, not compared (non-Sale row; no
 *     order_created payload; anomaly in the row's group)    -> `'unreconciled'`
 *   - order found, compared, discrepancyCents !== 0         -> `'discrepant'`
 *   - order found, compared, discrepancyCents === 0         -> `'matched'`
 * `'matched'` means ONLY "compared, and exactly right".
 *
 * Every figure here is PROVISIONAL -- see RECONCILIATION_MODEL and the
 * file-top banner.
 */
export async function importSettlementRows(reportDate: Date, rows: SettlementRow[]): Promise<SettlementImportResult> {
  return importSettlementRowsAttempt(reportDate, rows, false)
}

/**
 * Comparison is per ORDER GROUP, not per row (review round 2): Walmart's
 * documented `"Amount Type"` column (example `"Product Price"`) means a sale
 * arrives as several `Sale` rows per PO, and one fragment compared against
 * the whole order's gross manufactures a false discrepancy. So every `Sale`
 * row for a PO is summed, and the one resulting `discrepancyCents` is written
 * to every row in the group.
 *
 * Review round 4, finding 1(c): the group sum is built from the rows THIS
 * CALL ACTUALLY PERSISTS (after the ledger-key dedupe), never from the input
 * array -- so the stored discrepancy always agrees with what the group's
 * persisted rows add up to. And a group containing ANY anomalous row
 * (`AnomalyReason`) is not compared at all: every `Sale` row in it is
 * `'unreconciled'`. A sum that includes a row we cannot identify, or one we
 * do not understand, is not a figure worth stamping `'matched'` or
 * `'discrepant'`.
 *
 * =========================================================================
 * BLOCKER FOR TASK 13 -- finding B4, DELIBERATELY DEFERRED (not an oversight).
 * The group is scoped to ONE call and is never re-stamped. If one order's
 * itemised `Sale` rows arrive across more than one import call, the first
 * call stamps its rows against an incomplete group, the later call's new
 * siblings get their own (different) figure, the earlier rows keep their
 * stale `discrepancyCents` forever, and the group contradicts itself. The fix
 * is a two-phase insert-then-reconcile restructure: insert new rows, then for
 * every PO touched, re-sum ALL persisted `Sale` rows for it up to this
 * `reportDate` and re-stamp every one of them. Deferred until AFTER Task 13's
 * sandbox check because the real report shape (JSON wire format; possibly
 * commission lines carried on `Sale` rows) may change what gets aggregated,
 * and building it now risks building it twice. Task 13 cannot be closed
 * without resolving this. It depends on round 4's finding 1 (now fixed): a
 * DB-wide re-sum is only safe once no two distinct rows can share a key.
 * =========================================================================
 */
async function importSettlementRowsAttempt(
  reportDate: Date,
  rows: SettlementRow[],
  retried: boolean,
): Promise<SettlementImportResult> {
  const normalizedDate = truncateToUtcDate(reportDate)
  const reportDay = normalizedDate.toISOString().slice(0, 10)
  const result: SettlementImportResult = { imported: 0, linked: 0, unmatched: 0 }
  const byStatus = { matched: 0, unmatched: 0, discrepant: 0, unreconciled: 0 }
  const anomalies: Array<{ ledgerKey: string; externalOrderId: string; transactionType: string; reasons: AnomalyReason[] }> = []
  let skippedAsAlreadyImported = 0

  try {
    await prisma.$transaction(async (tx) => {
      // Phase 1: key every row, skip only what an EARLIER call already
      // persisted, and decide what this call will persist.
      const keyUses = new Map<string, number>()
      const toPersist: Array<{ row: SettlementRow; ledgerKey: string; reasons: AnomalyReason[] }> = []
      for (const row of rows) {
        const { key, hasIdentity } = baseLedgerKey(row, reportDay)
        const use = keyUses.get(key) ?? 0
        keyUses.set(key, use + 1)
        const ledgerKey = use === 0 ? key : `${key}#${use}`

        if (await tx.channelSettlement.findFirst({ where: { ledgerKey }, select: { id: true } })) {
          skippedAsAlreadyImported++
          continue
        }
        const reasons: AnomalyReason[] = []
        if (!hasIdentity) reasons.push('no_identity')
        if (use > 0) reasons.push('identity_collision')
        // Sale rows only: a Sale row is the only row this file compares, so
        // it is the only place a commission it cannot interpret affects a
        // figure it writes. Every non-Sale row is already 'unreconciled', and
        // a positive commission there (e.g. commission returned alongside a
        // customer refund) is plausible, not anomalous.
        if (row.transactionType === SALE_TRANSACTION_TYPE && row.feeCents > 0) reasons.push('positive_commission')
        toPersist.push({ row, ledgerKey, reasons })
      }

      // Phase 2: order-group aggregate over what will actually be persisted.
      const saleGroups = new Map<string, { sumCents: number; blocked: boolean }>()
      for (const { row, reasons } of toPersist) {
        if (row.transactionType !== SALE_TRANSACTION_TYPE) continue
        const g = saleGroups.get(row.externalOrderId) ?? { sumCents: 0, blocked: false }
        g.sumCents += row.amountCents
        if (reasons.length > 0) g.blocked = true
        saleGroups.set(row.externalOrderId, g)
      }

      // Phase 3: persist.
      for (const { row, ledgerKey, reasons } of toPersist) {
        const order = await tx.order.findUnique({
          where: { externalOrderId: row.externalOrderId },
          select: { id: true, externalOrderId: true },
        })

        let discrepancyCents: number | null = null
        let compared = false
        const group = saleGroups.get(row.externalOrderId)
        if (order?.externalOrderId && row.transactionType === SALE_TRANSACTION_TYPE && group && !group.blocked) {
          const expected = await expectedGrossCents(tx, order.externalOrderId)
          if (expected !== null) {
            compared = true
            discrepancyCents = group.sumCents - expected
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
            reconciliationModel: RECONCILIATION_MODEL,
            raw: row.raw as Prisma.InputJsonValue,
          },
        })
        result.imported++
        if (order) result.linked++
        else result.unmatched++
        byStatus[status]++
        if (reasons.length > 0) {
          anomalies.push({ ledgerKey, externalOrderId: row.externalOrderId, transactionType: row.transactionType, reasons })
        }
      }

      await recordAudit(
        {
          actorId: 'system',
          action: 'walmart_settlement_imported',
          // A settlement report is only ever pulled, never pushed.
          target: `settlement_report:${reportDay}`,
          after: {
            reportDate: reportDay,
            source: 'walmart_reconreport',
            // Finding 5: the provisional status, at data level.
            reconciliationModel: RECONCILIATION_MODEL,
            rowCount: rows.length,
            imported: result.imported,
            skippedAsAlreadyImported,
            linked: result.linked,
            byStatus,
            anomalies,
          },
        },
        tx,
      )
    })
  } catch (e) {
    if (!isConcurrentImportRace(e) || retried) throw e
    return importSettlementRowsAttempt(reportDate, rows, true)
  }

  return result
}

/**
 * `GET /v3/report/reconreport/reconFile` with query `{ reportDate }`
 * (`YYYY-MM-DD`). Actual sandbox response format (possibly zipped) is
 * unverified until Task 13 -- if it turns out not to be a bare CSV string or
 * `{ csv: string }`, the correction lands here and in the client only, per
 * the brief. The fetched documentation page's example response is JSON, not
 * CSV, so this function's whole premise is itself one of the unverified
 * assumptions Task 13 needs to check.
 */
export async function fetchAndImportSettlement(
  reportDate: Date,
  client: WalmartClient = getWalmartClient(),
): Promise<SettlementImportResult> {
  const res = await client.request('GET', '/v3/report/reconreport/reconFile', {
    query: { reportDate: reportDate.toISOString().slice(0, 10) },
  })
  const csv = typeof res === 'string' ? res : (res as any)?.csv
  if (typeof csv !== 'string') throw new Error('walmart settlement: unexpected report response shape')
  return importSettlementRows(reportDate, parseSettlementCsv(csv))
}

// =============================================================================
// LABELLED, UNVERIFIED ASSUMPTIONS -- not guessed at further:
//
// - COMMISSION ROWS. Unconfirmed recollection (not a documentation citation):
//   Walmart's `Amount Type` may include commission lines (e.g. "Commission
//   on Product") carried ON `Sale` rows as negative amounts. If real, the
//   order-group sum -- every `Sale` row's `amountCents` regardless of
//   `Amount Type` -- would put commission on the "gross" side and EVERY
//   order would show a false shortfall equal to its own commission. Not
//   fixed: no documentation shapes this.
// - WIRE FORMAT. The one fetched documentation example is a JSON response
//   (`{ reportData: [...], nextOffset, totalRecords, description }`), not the
//   CSV `parseSettlementCsv`/`fetchAndImportSettlement` assume. Task 13's.
// - AMOUNT TYPE ENUMERATION. Only `"Product Price"` is documented by example.
//   `Shipping` and `Tax` (used in tests) are inferred by analogy.
// - TRANSACTION KEY GRAIN. Whether a Transaction Key identifies one itemised
//   row or one whole transaction is undocumented; `baseLedgerKey` composes
//   the other identity fields in so either answer is safe.
// - REFUND-TIME BOUNDARY. Not load-bearing (no refund netting since round 3),
//   preserved for whoever builds refund-ROW reconciliation:
//   `ChannelEvent.processedAt` is this codebase's ingestion timestamp, not
//   Walmart's refund-issued timestamp, and Walmart's report "day" boundary is
//   not confirmed to be UTC.
// - B4 (cross-call re-stamping) -- see the BLOCKER FOR TASK 13 note above
//   `importSettlementRowsAttempt`.
// =============================================================================

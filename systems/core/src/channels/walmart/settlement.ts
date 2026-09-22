// Settlement import + matching. This is where the money reconciles: Walmart's
// settlement (recon) report against our own order records.
//
// Three facts were deliberately handed forward from earlier tasks for THIS
// file to resolve -- see the module-level doc comments below for each:
//   1. `Order.totalCents` excludes SHIPPING (mappers.ts filters to
//      chargeType === 'PRODUCT') -- `reconstructOrderGrossCents`.
//   2. `ChannelEvent.raw` holds the Walmart order payload as received, before
//      that filtering, specifically so this file could reconcile against it
//      -- `reconstructOrderGrossCents` reads it; `expectedNetCents` calls it.
//   3. `Order.status` is a coarse refund flag; the actual refunded amount
//      lives only in `ChannelEvent.raw` (return_created) -- `sumRefundedCents`.
import { Prisma } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toCents } from './mappers.js'

type Db = Prisma.TransactionClient

export interface SettlementRow {
  externalOrderId: string
  amountCents: number
  feeCents: number
  currency: string
  // Walmart's recon report "Transaction Type" column (e.g. `PaymentWithdrawn`
  // for a sale settlement, `Adjustment` for something else). Beyond the
  // brief's original interface: needed as a first-class field, not just
  // something buried in `raw`, for the transaction-type gate and the
  // idempotency key below -- see reconstructOrderGrossCents/expectedNetCents'
  // doc comments and ChannelSettlement.transactionType in schema.prisma.
  transactionType: string
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
 * the brief's own fixture has `PaymentWithdrawn` (a sale settlement) and
 * `Adjustment` side by side for different POs, and in practice a Sale row
 * and a later Refund row both arrive for the SAME PO. Comparing any row's
 * `amountCents` against the order's whole-lifetime expected net only makes
 * sense for the row that represents the actual sale settlement -- comparing
 * a partial/adjustment/refund row the same way manufactures a large false
 * discrepancy on both sides (the sale row looks overpaid, the refund row
 * looks like a near-total shortfall), and neither is real.
 *
 * ASSUMPTION, not verified against Walmart documentation -- reasoned from
 * the brief's own fixture, which is the only real Walmart shape available
 * before Task 13: `'PaymentWithdrawn'` is treated as the sale/settlement
 * type; every other `transactionType` is recorded (matched/unmatched by
 * order existence, same as before) but `discrepancyCents` is left `null`
 * rather than compared. If Task 13's real sandbox report uses different
 * type strings, or splits a sale across more than one `PaymentWithdrawn`
 * row, this constant and the assumption above are what need correcting.
 */
const SALE_TRANSACTION_TYPE = 'PaymentWithdrawn'

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
 * Fact 3, resolved: sums every recorded refund for this order from
 * return_created ChannelEvent.raw rows -- the only place a refunded amount
 * lives (Task 11's explicit handoff: `markOrderRefunded`/`ingestWalmartReturn`
 * flip `Order.status` to `'refunded'` with no amount column anywhere, by
 * deliberate decision).
 *
 * Always called, never gated on `Order.status === 'refunded'` (review round
 * 1, issue 6): `ingestWalmartReturn` only transitions `fulfilled ->
 * refunded` -- a refund arriving while the order is still `paid` records the
 * return event, with its real amount, and leaves the status alone. Gating
 * this query on the coarse flag would miss exactly that refund and report a
 * false shortfall for money Walmart already told us about. An order with no
 * matching return events sums to `0` regardless, so calling this
 * unconditionally is always safe, never wasted work that changes the
 * answer.
 *
 * `asOf` (review round 1, issue 2): only counts a return recorded ON OR
 * BEFORE the settlement report's own date. A report pulled well after a
 * refund landed would otherwise net that refund out of an OLDER report's
 * expected figure too, reporting a false overpayment on a report that, as
 * of the date it actually covers, was correct. Filters on `processedAt` --
 * this codebase's own ingestion timestamp for the return event, the only
 * refund-dated signal available (Walmart's return payload carries no
 * separate refund-issued date field this codebase extracts).
 *
 * There is no index or foreign key from a return event back to the order it
 * refunds: Walmart's return payload nests the order id as either
 * `purchaseOrderId` or `customerOrderInfo.purchaseOrderId`, and
 * `ChannelEvent` is keyed on the RETURN's own externalId (`returnOrderId`),
 * not the order's -- so this scans every `return_created` row up to `asOf`
 * and filters in memory rather than a targeted query. Acceptable for a
 * first cut at low return volume; flagged in the task report as the same
 * kind of "no index/no scheduler wiring yet" gap earlier Walmart tasks left
 * for later, not a new one invented here.
 *
 * Only counts rows Walmart itself marked as a real refund (`amount > 0`),
 * mirroring `ingestWalmartReturn`'s own `hasRealRefund` gate in
 * returns.service.ts exactly -- a `refundedAmount: { amount: 0 }` row is not
 * a refund and must not net out real revenue.
 */
async function sumRefundedCents(db: Db, externalOrderId: string, asOf: Date): Promise<number> {
  const cutoff = new Date(asOf.getTime() + 24 * 60 * 60 * 1000) // exclusive: start of the day AFTER asOf
  const events = await db.channelEvent.findMany({
    where: { eventType: 'return_created', processedAt: { lt: cutoff } },
  })
  let totalCents = 0
  for (const event of events) {
    const p = event.raw as any
    // Same precedence as returns.service.ts's own `purchaseOrderIdRaw`
    // (review round 1, issue 10): nested `customerOrderInfo.purchaseOrderId`
    // first, top-level `purchaseOrderId` as the fallback. This file
    // previously read them in the opposite order -- a real payload carrying
    // both, with different values, would have matched the wrong field.
    const purchaseOrderId = p?.customerOrderInfo?.purchaseOrderId ?? p?.purchaseOrderId
    if (purchaseOrderId !== externalOrderId) continue
    const amount = Number(p?.refundedAmount?.amount)
    if (Number.isFinite(amount) && amount > 0) totalCents += toCents(amount)
  }
  return totalCents
}

/**
 * The figure a sale-type settlement row's `amountCents` is checked against:
 * the order's gross value, reconstructed from its order_created
 * ChannelEvent.raw (fact 1 + fact 2, `reconstructOrderGrossCents` above),
 * minus every refund recorded on or before `reportDate` (fact 3,
 * `sumRefundedCents` above).
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
 * `discrepancyCents` null and `status: 'matched'` (an order genuinely was
 * found -- only the amount comparison is unavailable), not `'discrepant'`.
 *
 * Deliberately does NOT subtract `feeCents`/commission from this figure --
 * see `discrepancyCents`'s schema comment for why: there is no
 * independently-sourced expected commission rate anywhere in this codebase
 * to check Walmart's stated commission against, and inventing one would be
 * exactly the "estimate a figure" this project's money rule forbids. This
 * function reconstructs REVENUE, not net-of-commission payout.
 */
async function expectedNetCents(db: Db, externalOrderId: string, reportDate: Date): Promise<number | null> {
  const event = await db.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: externalOrderId, eventType: 'order_created' } },
  })
  if (event?.raw == null) return null
  const grossCents = reconstructOrderGrossCents(event.raw)
  if (grossCents === null) return null
  const refundedCents = await sumRefundedCents(db, externalOrderId, reportDate)
  return grossCents - refundedCents
}

function truncateToUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
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
 * Idempotency key (review round 1, issue 4, overruling this file's
 * original narrower key): `(externalOrderId, reportDate, transactionType,
 * amountCents, feeCents)`, enforced by a DB-level `@@unique` constraint
 * (schema.prisma), not app-level `findFirst`-then-`create` alone --
 * `findFirst`-then-`create` is non-atomic under two genuinely concurrent
 * imports of the same report (both can pass the `findFirst` read before
 * either commits). The `findFirst` check below still runs first, as a cheap
 * fast path that avoids a doomed `create` in the common sequential case;
 * the unique constraint is the actual guarantee. `toCents` is deterministic
 * for identical input, so two pulls of the truly identical row never differ
 * by rounding -- and if two pulls of the same (PO, date, type) genuinely
 * report a different `amountCents`/`feeCents`, that is a correction, not a
 * duplicate, and a human should see both rows rather than have the second
 * silently vanish.
 *
 * The whole import runs inside ONE `prisma.$transaction` (review round 1:
 * previously there was none) for two reasons: (a) `recordAudit` below must
 * commit atomically with everything it's reporting on, matching every other
 * money-affecting write in this codebase; (b) a malformed row that makes a
 * `create()` throw (e.g. `NaN` cents from `parseSettlementCsv`'s comma-split
 * limitation, see its doc comment) rolls back the ENTIRE report import
 * rather than committing everything before it and silently leaving the
 * report half-imported. A concurrent-import race (`isConcurrentImportRace`)
 * rolls back the whole attempt the same way `ingestWalmartOrder` does, and
 * is retried exactly once: the retry's own `findFirst` checks will correctly
 * skip everything the winning transaction already committed, so it is a
 * safe, idempotent re-run, not a double-import.
 *
 * For each non-duplicate row: create one `ChannelSettlement`, storing
 * `netCents = amountCents + feeCents` unconditionally (pure arithmetic on
 * the row itself, no order needed). If an `Order` with that
 * `externalOrderId` exists, link `orderId`; if the row's `transactionType`
 * is the sale type (`SALE_TRANSACTION_TYPE`) AND `expectedNetCents` can
 * compute a real figure, set `discrepancyCents = amountCents -
 * expectedNetCents` and `status: 'discrepant'` when that is non-zero,
 * `'matched'` when it's exactly zero. Every other case -- no order, a
 * non-sale transaction type, or `expectedNetCents` returning `null` --
 * leaves `discrepancyCents` null; `status` is `'unmatched'` only when there
 * is genuinely no order.
 *
 * A summary audit row (`walmart_settlement_imported`) is written once per
 * call, inside the same transaction, recording `reportDate`, the input row
 * count, and the final `imported`/`matched`/`unmatched`/`discrepant`
 * counts -- these are financial records being created; every other
 * money-affecting write in this codebase leaves an audit trail and this one
 * previously left none.
 */
export async function importSettlementRows(
  reportDate: Date,
  rows: SettlementRow[],
): Promise<{ imported: number; matched: number; unmatched: number }> {
  return importSettlementRowsAttempt(reportDate, rows, false)
}

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

  try {
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const dupe = await tx.channelSettlement.findFirst({
          where: {
            externalOrderId: row.externalOrderId,
            reportDate: normalizedDate,
            transactionType: row.transactionType,
            amountCents: row.amountCents,
            feeCents: row.feeCents,
          },
        })
        if (dupe) continue

        const order = await tx.order.findUnique({
          where: { externalOrderId: row.externalOrderId },
          select: { id: true, externalOrderId: true },
        })

        let discrepancyCents: number | null = null
        if (order && order.externalOrderId && row.transactionType === SALE_TRANSACTION_TYPE) {
          const expected = await expectedNetCents(tx, order.externalOrderId, normalizedDate)
          if (expected !== null) discrepancyCents = row.amountCents - expected
        }

        let status: 'matched' | 'unmatched' | 'discrepant'
        if (!order) status = 'unmatched'
        else if (discrepancyCents !== null && discrepancyCents !== 0) status = 'discrepant'
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
            raw: row.raw as Prisma.InputJsonValue,
          },
        })
        imported++
        if (order) matched++
        else unmatched++
        if (status === 'discrepant') discrepant++
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
 * the brief.
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

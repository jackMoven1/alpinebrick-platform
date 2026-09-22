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
import { type WalmartClient, getWalmartClient } from './client.js'
import { toCents } from './mappers.js'

export interface SettlementRow {
  externalOrderId: string
  amountCents: number
  feeCents: number
  currency: string
  raw: Record<string, string>
}

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
      raw,
    })
  }
  return rows
}

// --------------------------------------------------------------------------
// Reconciliation arithmetic
// --------------------------------------------------------------------------

/**
 * Fact 1 + fact 2, resolved: the gross order value Walmart itself computed,
 * reconstructed straight from the order_created ChannelEvent.raw payload --
 * the exact same shape `toCanonicalOrder` (mappers.ts) reads, but summing
 * EVERY charge on every line (PRODUCT *and* SHIPPING, each with its own tax),
 * not just PRODUCT. `toCanonicalOrder` filters to PRODUCT only when it builds
 * `Order.totalCents` -- that filtering is what makes
 * `settlement.amountCents === order.totalCents` the wrong comparison
 * whenever an order had a SHIPPING charge. This function is how settlement
 * reconciliation gets Walmart's real figure instead of comparing against a
 * number we already know is short by exactly the shipping charge.
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
 * `expectedNetCents` falls back to `Order.totalCents`, a real stored figure,
 * rather than this function inventing one.
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
 * There is no index or foreign key from a return event back to the order it
 * refunds: Walmart's return payload nests the order id as either
 * `purchaseOrderId` or `customerOrderInfo.purchaseOrderId` (returns.service.ts
 * accepts both), and `ChannelEvent` is keyed on the RETURN's own externalId
 * (`returnOrderId`), not the order's -- so this scans every `return_created`
 * row and filters in memory rather than a targeted query. Acceptable for a
 * first cut at low return volume; flagged in the task report as the same
 * kind of "no index/no scheduler wiring yet" gap earlier Walmart tasks left
 * for later, not a new one invented here.
 *
 * Only counts rows Walmart itself marked as a real refund (`amount > 0`),
 * mirroring `ingestWalmartReturn`'s own `hasRealRefund` gate in
 * returns.service.ts exactly -- a `refundedAmount: { amount: 0 }` row is not
 * a refund and must not net out real revenue.
 */
async function sumRefundedCents(externalOrderId: string): Promise<number> {
  const events = await prisma.channelEvent.findMany({ where: { eventType: 'return_created' } })
  let totalCents = 0
  for (const event of events) {
    const p = event.raw as any
    const purchaseOrderId = p?.purchaseOrderId ?? p?.customerOrderInfo?.purchaseOrderId
    if (purchaseOrderId !== externalOrderId) continue
    const amount = Number(p?.refundedAmount?.amount)
    if (Number.isFinite(amount) && amount > 0) totalCents += toCents(amount)
  }
  return totalCents
}

/**
 * The figure a settlement row's `amountCents` is checked against: the
 * order's gross value (shipping-inclusive when an order_created ChannelEvent
 * is on file and parses cleanly; `Order.totalCents` otherwise -- a real
 * stored number, not a fabricated one, for an order this codebase somehow
 * has no raw payload for) minus every recorded refund (fact 3, above; `0`
 * when the order isn't `'refunded'`).
 *
 * Deliberately does NOT subtract `feeCents`/commission from this figure --
 * see `discrepancyCents`'s schema comment and the task report for why: there
 * is no independently-sourced expected commission rate anywhere in this
 * codebase to check Walmart's stated commission against, and inventing one
 * would be exactly the "estimate a figure" this project's money rule
 * forbids. This function reconstructs REVENUE, not net-of-commission payout.
 */
async function expectedNetCents(order: { externalOrderId: string; totalCents: number; status: string }): Promise<number> {
  let grossCents = order.totalCents
  const event = await prisma.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: order.externalOrderId, eventType: 'order_created' } },
  })
  if (event?.raw != null) {
    const reconstructed = reconstructOrderGrossCents(event.raw)
    if (reconstructed !== null) grossCents = reconstructed
  }
  const refundedCents = order.status === 'refunded' ? await sumRefundedCents(order.externalOrderId) : 0
  return grossCents - refundedCents
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------

/**
 * Idempotency key: `(externalOrderId, reportDate, amountCents)`, exactly as
 * specified -- a re-import of the identical report row (same PO, same report
 * date, same dollar amount) is a genuine duplicate delivery and is skipped.
 * `feeCents` is deliberately NOT part of the key: if Walmart re-issues a
 * corrected row for the same PO/date with the same Amount but a different
 * Commission Amount, this key treats it as a duplicate and the correction is
 * silently dropped. That is a real, inherited limitation of this exact key
 * (see the task report) -- not something this task's scope extends to
 * fixing, and a narrower key would risk the opposite failure: double-counting
 * a genuine re-delivery whose amount happens to be reported with different
 * rounding across two pulls of the same report.
 *
 * For each non-duplicate row: create one `ChannelSettlement`. If an `Order`
 * with that `externalOrderId` exists, link `orderId`, set
 * `status: 'matched'`, and compute `discrepancyCents` (see
 * `expectedNetCents` above) -- signed, `amountCents - expectedNetCents`:
 * positive means Walmart remitted MORE than expected, negative means LESS,
 * zero is an exact match. Otherwise `status: 'unmatched'` and
 * `discrepancyCents` stays `null` -- there is no order to compare the amount
 * against, so recording a number there would be comparing two things that
 * aren't comparable. `status: 'unmatched'` is itself the review-queue
 * surface for that row; `discrepancyCents !== 0` on a `'matched'` row is the
 * review-queue surface for this one.
 */
export async function importSettlementRows(
  reportDate: Date,
  rows: SettlementRow[],
): Promise<{ imported: number; matched: number; unmatched: number }> {
  let imported = 0
  let matched = 0
  let unmatched = 0
  for (const row of rows) {
    const dupe = await prisma.channelSettlement.findFirst({
      where: { externalOrderId: row.externalOrderId, reportDate, amountCents: row.amountCents },
    })
    if (dupe) continue
    const order = await prisma.order.findUnique({
      where: { externalOrderId: row.externalOrderId },
      select: { id: true, externalOrderId: true, totalCents: true, status: true },
    })
    const discrepancyCents = order && order.externalOrderId
      ? row.amountCents - (await expectedNetCents({ externalOrderId: order.externalOrderId, totalCents: order.totalCents, status: order.status }))
      : null
    await prisma.channelSettlement.create({
      data: {
        reportDate,
        externalOrderId: row.externalOrderId,
        amountCents: row.amountCents,
        feeCents: row.feeCents,
        currency: row.currency,
        orderId: order?.id,
        status: order ? 'matched' : 'unmatched',
        discrepancyCents,
        raw: row.raw as Prisma.InputJsonValue,
      },
    })
    imported++
    if (order) matched++
    else unmatched++
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

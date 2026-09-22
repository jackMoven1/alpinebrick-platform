import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { toCanonicalOrder } from './mappers.js'
import { enqueueJob } from './outbox.js'

export class ChannelError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

/**
 * Ingest one Walmart order into the canonical order spine.
 *
 * Idempotent on ChannelEvent(externalId, 'order_created'): a re-delivery
 * (webhook retry racing the poller, or the poller re-scanning) is a no-op,
 * not an error and not a duplicate order.
 *
 * Stock reservation, order/line creation, and the ChannelEvent all happen in
 * one transaction together with the audit row (recordAudit is passed `tx`,
 * not the global prisma client) -- if the reservation fails partway through,
 * everything commits or nothing does, including the audit entry.
 *
 * A failed ingest (unknown_sku, insufficient_stock) deliberately does NOT
 * write a ChannelEvent: that is what lets a later retry succeed once the SKU
 * is listed or stock is replenished, and it is the surface an operator alert
 * watches.
 */
export async function ingestWalmartOrder(
  payload: unknown,
  source: 'webhook' | 'poll',
): Promise<{ orderId: string | null; created: boolean }> {
  let canonical
  try {
    canonical = toCanonicalOrder(payload)
  } catch (e: any) {
    throw new ChannelError('unmappable_order', String(e?.message ?? e))
  }

  const existing = await prisma.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: canonical.externalOrderId, eventType: 'order_created' } },
  })
  if (existing) {
    const order = await prisma.order.findUnique({ where: { externalOrderId: canonical.externalOrderId }, select: { id: true } })
    return { orderId: order?.id ?? null, created: false }
  }

  const listings = await prisma.channelListing.findMany({
    where: { walmartSku: { in: canonical.lines.map((l) => l.walmartSku) } },
    include: { variant: true },
  })
  const byWalmartSku = new Map(listings.map((l) => [l.walmartSku, l]))
  for (const line of canonical.lines) {
    if (!byWalmartSku.has(line.walmartSku)) {
      throw new ChannelError('unknown_sku', `no channel listing for walmart sku ${line.walmartSku}`)
    }
  }

  // Money is integer cents throughout: unitPriceCents and lineTaxCents were
  // already converted from Walmart's decimal dollars by toCents() inside
  // toCanonicalOrder() (mappers.ts). Everything from here down is integer
  // arithmetic on those cents -- never a float.
  const subtotalCents = canonical.lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0)
  const taxCents = canonical.lines.reduce((s, l) => s + l.lineTaxCents, 0)

  const orderId = await prisma.$transaction(async (tx) => {
    // Conditional UPDATE is the concurrency control: the affected-row count,
    // not a prior read, decides whether the reservation succeeded. Two
    // concurrent ingests racing the same variant can't both pass a
    // read-then-write check; here at most one UPDATE can match enough rows,
    // so at most one ingest reserves the stock.
    for (const line of canonical.lines) {
      const listing = byWalmartSku.get(line.walmartSku)!
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${listing.variantId} AND on_hand - reserved >= ${line.quantity}`
      if (affected === 0) {
        throw new ChannelError('insufficient_stock', `not enough stock for walmart sku ${line.walmartSku}`)
      }
    }

    const order = await tx.order.create({
      data: {
        email: canonical.email,
        shipToState: canonical.shipToState,
        status: 'paid',
        channel: 'walmart',
        externalOrderId: canonical.externalOrderId,
        subtotalCents,
        taxCents,
        totalCents: subtotalCents + taxCents,
        taxRateBps: 0,
        taxJurisdiction: 'walmart_facilitator',
        lines: {
          create: canonical.lines.map((l) => {
            const listing = byWalmartSku.get(l.walmartSku)!
            return {
              variantId: listing.variantId,
              sku: listing.variant.sku,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              lineSubtotalCents: l.quantity * l.unitPriceCents,
            }
          }),
        },
      },
      select: { id: true },
    })

    await tx.channelEvent.create({
      data: { source, externalId: canonical.externalOrderId, eventType: 'order_created' },
    })

    // Passing `tx` (not the module-level `prisma` client) is load-bearing:
    // it puts this audit row in the same transaction as the reservation,
    // order, and ChannelEvent above, so a rollback -- e.g. insufficient
    // stock thrown mid-loop -- takes the audit row with it too.
    await recordAudit({
      actorId: 'system',
      action: 'walmart_order_ingested',
      target: order.id,
      after: { externalOrderId: canonical.externalOrderId },
    }, tx)

    return order.id
  })

  await enqueueJob('walmart_ack_order', { externalOrderId: canonical.externalOrderId }, { dedupeKey: `ack:${canonical.externalOrderId}` })

  return { orderId, created: true }
}

import { Prisma } from '@prisma/client'
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
 * True for a Prisma unique-constraint violation. Inside this transaction the
 * only writes that can collide are `Order.externalOrderId` and
 * `ChannelEvent(externalId, eventType)` -- both only ever collide with
 * another delivery of the *same* Walmart order racing this one (the
 * `ChannelJob.dedupeKey` collision that a concurrent ack-enqueue could hit is
 * handled internally by `enqueueJob`, which never lets it surface as a
 * throw). So any P2002 reaching the caller here means "another delivery of
 * this order won the race," never an unrelated conflict.
 */
function isConcurrentDeliveryRace(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

/**
 * Ingest one Walmart order into the canonical order spine.
 *
 * Idempotent on ChannelEvent(externalId, 'order_created'): a re-delivery
 * (webhook retry racing the poller, or the poller re-scanning) is a no-op,
 * not an error and not a duplicate order. That covers the SEQUENTIAL case --
 * one delivery fully commits before the next one starts and sees its
 * ChannelEvent. Two deliveries racing TRULY concurrently can both pass that
 * read before either commits; the `isConcurrentDeliveryRace` catch below
 * around the transaction covers that case too, so both the sequential and
 * concurrent forms of "re-delivery" resolve to the same
 * `{ created: false }` no-op rather than one of them surfacing a raw
 * constraint-violation error.
 *
 * Stock reservation, order/line creation, the ChannelEvent, the audit row,
 * and the outbox job that schedules the Walmart ack are all in one
 * transaction (recordAudit and enqueueJob are both passed `tx`, not the
 * global prisma client) -- if any step fails partway through, everything
 * commits or nothing does. The ack job has to be in here too, not enqueued
 * after: enqueued after, a crash or DB blip between this transaction's
 * commit and the enqueue call would leave an ingested order with no ack job
 * and no retry path (no ChannelEvent-based re-delivery can create the
 * missing job, because a re-delivery short-circuits at the idempotency
 * check above before ever reaching the enqueue step) -- an order Walmart
 * never hears back about, with no error raised anywhere.
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
  // NOTE (flagged to the plan owner, not resolved here -- see task-5-report.md
  // "Important 4"): `payload` is never persisted past this function. mappers.ts
  // only maps `charges.charge[chargeType === 'PRODUCT']`, so Walmart's
  // SHIPPING charges (and their tax) are read here and then discarded --
  // nothing in this schema captures the raw order payload the way
  // `ChannelSettlement.raw` captures a raw settlement report. Task 12
  // (settlement matching) will need Walmart's actual remitted total,
  // including shipping, to reconcile against `Order.totalCents`; as ingested
  // today, that information does not exist anywhere after this call returns.
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

  // `ChannelListing.status` is deliberately not filtered here (e.g. to
  // `status: 'live'`). Walmart has already accepted and sent us this order
  // against whatever SKU it has on file, regardless of what our own listing
  // status says right now -- refusing to ingest against a listing we've
  // since drafted or retired would strand a real, already-placed order with
  // no way to recover it. A listing existing at all is the only precondition;
  // its lifecycle status governs future catalog pushes, not past orders.
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

  let orderId: string
  try {
    orderId = await prisma.$transaction(async (tx) => {
      // Conditional UPDATE is the concurrency control: the affected-row
      // count, not a prior read, decides whether the reservation succeeded.
      // Two concurrent ingests racing the same variant can't both pass a
      // read-then-write check; the conditional UPDATE never over-reserves --
      // it matches (and reserves) only up to whatever `on_hand - reserved`
      // actually allows at the moment it runs, however many concurrent
      // ingests that turns out to satisfy.
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

      // Passing `tx` (not the default client) is load-bearing: it puts this
      // job in the same transaction as the reservation, order and
      // ChannelEvent above, so ingesting the order and scheduling its
      // Walmart ack are atomic -- see the function doc comment above for why
      // that matters (a post-commit enqueue can silently lose the ack).
      await enqueueJob(
        'walmart_ack_order',
        { externalOrderId: canonical.externalOrderId },
        { dedupeKey: `ack:${canonical.externalOrderId}` },
        tx,
      )

      // Passing `tx` here too is load-bearing the same way: it puts this
      // audit row in the same transaction as everything above, so a
      // rollback -- e.g. insufficient stock thrown mid-loop, or this write
      // itself failing -- takes the reservation, order, ChannelEvent and job
      // with it, not just itself.
      await recordAudit({
        actorId: 'system',
        action: 'walmart_order_ingested',
        target: `order:${order.id}`,
        after: { externalOrderId: canonical.externalOrderId },
      }, tx)

      return order.id
    })
  } catch (e) {
    if (!isConcurrentDeliveryRace(e)) throw e
    // Lost the race: another delivery of this same order (webhook vs. poll,
    // or two overlapping poll passes) committed first. Its ChannelEvent and
    // Order now exist, so resolve exactly the way the idempotency check
    // above would have if it had run a moment later, instead of surfacing a
    // raw constraint-violation error for what is contractually a no-op.
    const order = await prisma.order.findUnique({ where: { externalOrderId: canonical.externalOrderId }, select: { id: true } })
    return { orderId: order?.id ?? null, created: false }
  }

  return { orderId, created: true }
}

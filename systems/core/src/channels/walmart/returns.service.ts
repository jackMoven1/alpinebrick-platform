// Returns + refunds.
//
// Walmart tells us about a return two ways -- a webhook delivery and the
// reconciliation poller (pollers.ts's pollWalmartReturns) -- and either can
// arrive more than once for the same return, so ingestion is idempotent the
// same way orders.ingest.ts's ingestWalmartOrder is:
// ChannelEvent(returnOrderId, 'return_created') uniqueness is the gate, not a
// business check.
//
// Stock decision (Task 11): a refund never moves inventory, in either
// direction, regardless of whether Walmart's returned goods physically came
// back. Walmart's Returns API payload tells us money moved (`refundedAmount`
// present); it does not tell us the goods arrived in sellable condition, and
// this schema has no field to record that distinction (no returnReason, no
// "received" flag on ChannelEvent or Order). The brief is explicit that even
// a physical return's restock is a manual admin action, out of v1 scope: an
// operator inspects the box before `Inventory.onHand`/`reserved` change. A
// refund issued with no physical return at all (goodwill, lost-in-transit)
// needs exactly the same non-touch. One rule -- markOrderRefunded never
// writes to `inventory` -- covers both cases correctly, so there is no
// conditional stock UPDATE anywhere in this file: there is no stock movement
// to guard. If a future task adds an operator-confirmed "goods received"
// restock action, it is a new, explicit, conditional-UPDATE-guarded mutation
// on top of this file, not a change to this decision.
import { Prisma } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { OrderError } from '../../orders/orders.service.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { ChannelError } from './orders.ingest.js'

type Db = Prisma.TransactionClient

/**
 * True for a Prisma unique-constraint violation -- mirrors
 * `isConcurrentDeliveryRace` in orders.ingest.ts exactly, one file over,
 * because the failure mode is the same one: two truly concurrent deliveries
 * of the same return (webhook racing the poller) can both pass the
 * `ChannelEvent` idempotency read before either commits. The sequential case
 * (one delivery fully commits before the next starts) is already handled by
 * that read; this catch is only for the rarer concurrent case, so the loser
 * resolves to the same `{ created: false }` no-op as a sequential re-delivery
 * instead of surfacing a raw constraint-violation error.
 */
function isConcurrentDeliveryRace(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

/**
 * fulfilled -> refunded. No inventory change: see the file doc comment.
 *
 * Split into this tx-scoped core plus the exported `markOrderRefunded`
 * wrapper so `ingestWalmartReturn` can run the transition INSIDE its own
 * transaction, alongside the ChannelEvent and `walmart_return_ingested` audit
 * row that record the return itself -- exactly the same reason
 * `enqueueIdempotentJob` and `recordAudit` both accept a `tx` parameter
 * instead of always opening their own transaction: nesting a second
 * `prisma.$transaction` inside `ingestWalmartReturn`'s would open an
 * independent connection/transaction, not a true nested one, and could
 * commit the refund while the ChannelEvent that is supposed to make it
 * idempotent rolls back (or vice versa).
 */
async function refundInTx(tx: Db, orderId: string, actorId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId } })
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  if (order.status !== 'fulfilled') {
    throw new OrderError('invalid_transition', `cannot refund a ${order.status} order`)
  }
  await tx.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
  // Passing `tx` is load-bearing, same as every other transition in
  // orders.service.ts: a rolled-back transition (e.g. a status race lost
  // between the read above and this write) leaves no orphan audit row.
  await recordAudit({
    actorId,
    action: 'walmart_order_refunded',
    target: `order:${orderId}`,
    before: { status: order.status },
    after: { status: 'refunded' },
  }, tx)
}

/**
 * Standalone entry point: `fulfilled -> refunded`, throwing
 * `OrderError('invalid_transition')` for any other current status (matching
 * `markOrderPaid` / `fulfillOrder` / `cancelOrder` in orders.service.ts
 * exactly -- same error type, same "load, validate, update, audit-with-tx,
 * all inside one prisma.$transaction" shape). Opens its own transaction via
 * `refundInTx`; `ingestWalmartReturn` below calls `refundInTx` directly
 * instead, inside its own transaction.
 */
export async function markOrderRefunded(orderId: string, actorId = 'system'): Promise<void> {
  await prisma.$transaction((tx) => refundInTx(tx, orderId, actorId))
}

/**
 * Ingest one Walmart return.
 *
 * Idempotent on ChannelEvent(externalId, 'return_created'): a re-delivery
 * (webhook retry racing the poller, or the poller re-scanning a return it has
 * already seen) resolves to `{ created: false }` -- a no-op, not an error and
 * not a second refund. The read-then-create idempotency check below covers
 * the sequential case; `isConcurrentDeliveryRace` above covers two
 * deliveries racing truly concurrently.
 *
 * `ChannelEvent.raw` is populated with `payload` exactly as received (the
 * same guarantee Task 5's migration 20260922110000_add_channel_event_raw_payload
 * established for orders, extended here to returns per this task's brief):
 * `mappers.ts` only maps what the canonical order needs, so Task 12's
 * settlement reconciliation needs Walmart's original return payload, not a
 * derived shape.
 *
 * The order lookup, the ChannelEvent write, the `walmart_return_ingested`
 * audit row, and -- only when Walmart has already refunded a `fulfilled`
 * order (`refundedAmount` present) -- the `fulfilled -> refunded` transition
 * (with its own `walmart_order_refunded` audit row) all happen inside ONE
 * transaction, the same way `ingestWalmartOrder` does it: recording the
 * return and refunding the order commit or roll back together, so the
 * idempotency guarantee above can never observe a return that was recorded
 * without being reflected in the order, or an order refunded without a
 * recorded return backing it.
 *
 * A return for a `purchaseOrderId` we don't recognise, or one that arrives
 * before the order reaches `fulfilled`, is still recorded (ChannelEvent +
 * audit) -- it just skips the transition. That mirrors `ingestWalmartOrder`'s
 * stance of never silently dropping a real event; only a genuinely
 * unmappable payload (missing `returnOrderId`) throws before anything is
 * written, so a corrected re-delivery can still succeed.
 */
export async function ingestWalmartReturn(payload: unknown, source: 'webhook' | 'poll'): Promise<{ created: boolean }> {
  const p = payload as any
  const returnOrderId: unknown = p?.returnOrderId
  if (typeof returnOrderId !== 'string' || !returnOrderId) {
    throw new ChannelError('unmappable_return', 'missing returnOrderId')
  }
  const purchaseOrderId: string | undefined = p?.customerOrderInfo?.purchaseOrderId ?? p?.purchaseOrderId

  const existing = await prisma.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: returnOrderId, eventType: 'return_created' } },
  })
  if (existing) return { created: false }

  try {
    await prisma.$transaction(async (tx) => {
      const order = purchaseOrderId
        ? await tx.order.findUnique({ where: { externalOrderId: purchaseOrderId } })
        : null

      await tx.channelEvent.create({
        data: {
          source,
          externalId: returnOrderId,
          eventType: 'return_created',
          raw: payload as Prisma.InputJsonValue,
        },
      })

      await recordAudit({
        actorId: 'system',
        action: 'walmart_return_ingested',
        target: order ? `order:${order.id}` : `walmart_return:${returnOrderId}`,
        after: { returnOrderId, purchaseOrderId, source },
      }, tx)

      if (order && order.status === 'fulfilled' && p?.refundedAmount) {
        await refundInTx(tx, order.id, 'system')
      }
    })
  } catch (e) {
    if (!isConcurrentDeliveryRace(e)) throw e
    return { created: false }
  }

  return { created: true }
}

/**
 * Operator-triggered: ask Walmart to refund a return in full, as Walmart
 * itself computed the refundable lines. Not idempotency-guarded here --
 * unlike ingestion, this is a direct, explicit operator action (a POST with
 * an empty body), not something a re-delivered event could trigger twice.
 */
export async function issueWalmartRefund(returnOrderId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  await client.request('POST', `/v3/returns/${returnOrderId}/refund`, { body: {} })
}

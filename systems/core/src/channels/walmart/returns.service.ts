// Returns + refunds.
//
// Walmart can tell us about a return two ways -- a webhook delivery and the
// reconciliation poller (pollers.ts's pollWalmartReturns) -- and either can
// arrive more than once for the same return, so ingestion is idempotent the
// same way orders.ingest.ts's ingestWalmartOrder is:
// ChannelEvent(returnOrderId, 'return_created') uniqueness is the gate, not a
// business check.
//
// Only the poller is wired: scheduler.ts's startWalmartScheduler runs
// pollWalmartReturns every 30 minutes, but only in the worker process
// (worker.ts), and only when WALMART_SYNC_ENABLED=true -- so nothing reaches
// this file until core-worker is provisioned with that flag. The webhook path
// is not wired: webhooks.routes.ts only recognises
// `eventType === 'ORDER_CREATED'` and 202s everything else, a return event
// included.
//
// Stock decision (Task 11): a refund never moves inventory, in either
// direction, regardless of whether Walmart's returned goods physically came
// back. Walmart's Returns API payload tells us money moved (`refundedAmount`
// present and > 0); it does not tell us the goods arrived in sellable
// condition, and this schema has no field to record that distinction (no
// returnReason, no "received" flag on ChannelEvent or Order). The brief is
// explicit that even a physical return's restock is a manual admin action,
// out of v1 scope: an operator inspects the box before
// `Inventory.onHand`/`reserved` change. A refund issued with no physical
// return at all (goodwill, lost-in-transit) needs exactly the same
// non-touch. One rule -- markOrderRefunded never writes to `inventory` --
// covers both cases correctly, so there is no conditional stock UPDATE
// anywhere in this file: there is no stock movement to guard. If a future
// task adds an operator-confirmed "goods received" restock action, it is a
// new, explicit, conditional-UPDATE-guarded mutation on top of this file,
// not a change to this decision.
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
 * Takes the order the CALLER already loaded (`{ id, status }`) instead of
 * re-reading it -- a prior revision of this function re-read the row via its
 * own `tx.order.findUnique`, which under READ COMMITTED is a second,
 * independent snapshot that can legitimately differ from the caller's own
 * read taken moments earlier in the same transaction, for no reason other
 * than redundancy. One read per call site is enough; what actually has to be
 * race-safe is the write below, not the read.
 *
 * The status check against that single read is a fast-fail for the common
 * case (the caller's own snapshot already shows the wrong status -- no need
 * to touch the DB at all). It is NOT what makes this function safe under
 * concurrency: Walmart issues one return order per return, so more than one
 * return for the same order arriving around the same time is ordinary, not
 * exotic (RO-1 and RO-2 against the same PO, both carrying a refund, both
 * landing within the same poll sweep or racing a webhook). Two concurrent
 * calls can both load the order while it still reads `fulfilled` and both
 * pass the check above before either commits. The actual gate is the
 * conditional UPDATE: only one concurrent caller's `WHERE status =
 * 'fulfilled'` can still match once the other has committed, exactly the
 * same conditional-UPDATE-with-affected-row-count pattern every stock
 * movement in this codebase uses (see orders.service.ts). The loser's
 * `affected === 0` throws `invalid_transition` -- callers that expect a
 * possible race (`ingestWalmartReturn`, below) catch specifically that and
 * treat it as "already refunded by another return for this order," not an
 * error; `markOrderRefunded`'s callers get the same `OrderError` a genuine
 * double-call would produce, unchanged.
 */
async function refundInTx(tx: Db, order: { id: string; status: string }, actorId: string): Promise<void> {
  if (order.status !== 'fulfilled') {
    throw new OrderError('invalid_transition', `cannot refund a ${order.status} order`)
  }
  const affected = await tx.$executeRaw`
    UPDATE orders SET status = 'refunded' WHERE id = ${order.id} AND status = 'fulfilled'`
  if (affected === 0) {
    throw new OrderError('invalid_transition', `cannot refund a ${order.status} order`)
  }
  // Passing `tx` is load-bearing, same as every other transition in
  // orders.service.ts: a rolled-back transition (e.g. this same statement's
  // own affected-row check failing above) leaves no orphan audit row.
  await recordAudit({
    actorId,
    action: 'walmart_order_refunded',
    target: `order:${order.id}`,
    before: { status: order.status },
    after: { status: 'refunded' },
  }, tx)
}

/**
 * Standalone entry point: `fulfilled -> refunded`, throwing
 * `OrderError('invalid_transition')` for any other current status (matching
 * `markOrderPaid` / `fulfillOrder` / `cancelOrder` in orders.service.ts --
 * same error type, same "load, validate, conditionally write, audit-with-tx,
 * all inside one prisma.$transaction" shape, strengthened here with the
 * affected-row gate `refundInTx` documents above). Opens its own transaction,
 * loads the order once, and hands it to `refundInTx`; `ingestWalmartReturn`
 * below calls `refundInTx` directly instead, inside its own transaction, with
 * the order it already loaded there.
 */
export async function markOrderRefunded(orderId: string, actorId = 'system'): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } })
    if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
    await refundInTx(tx, order, actorId)
  })
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
 * `refundedAmount` is gated on `.amount > 0`, not just presence: Walmart can
 * send `refundedAmount: { amount: 0 }` (nothing actually refunded yet) or a
 * partial-line refund, and either would otherwise flip the whole order to
 * `refunded` on a signal that isn't a real, full refund. `Order.status` is a
 * COARSE flag either way -- refunded vs. not -- and cannot represent a
 * partial. This function deliberately does not add anywhere to store the
 * actual refunded amount: the only place it lives is `ChannelEvent.raw` on
 * this return's row. Task 12 (settlement reconciliation) needs that
 * constraint handed to it explicitly, not discovered.
 *
 * The order lookup, the ChannelEvent write, the `walmart_return_ingested`
 * audit row, and -- only when Walmart has already refunded a `fulfilled`
 * order -- the `fulfilled -> refunded` transition (with its own
 * `walmart_order_refunded` audit row) all happen inside ONE transaction, the
 * same way `ingestWalmartOrder` does it: recording the return and refunding
 * the order commit or roll back together, so the idempotency guarantee above
 * can never observe a return that was recorded without being reflected in
 * the order, or an order refunded without a recorded return backing it.
 *
 * `refundInTx` can lose the "is this order still fulfilled" race against
 * ANOTHER return for the same order committing first (ordinary under
 * Walmart's one-return-order-per-return model -- see its doc comment) --
 * that specific `OrderError('invalid_transition')` is caught and swallowed
 * here, not rethrown: this return's own ChannelEvent and
 * `walmart_return_ingested` audit row are still real and must still commit,
 * only the now-redundant transition is skipped. Any other error still aborts
 * the whole transaction.
 *
 * A return for a `purchaseOrderId` we don't recognise (including one that
 * isn't a string at all -- Walmart's payload shape is not force-verified
 * beyond `returnOrderId`), or one that arrives before the order reaches
 * `fulfilled`, is still recorded (ChannelEvent + audit) -- it just skips the
 * transition. That mirrors `ingestWalmartOrder`'s stance of never silently
 * dropping a real event; only a genuinely unmappable payload (missing
 * `returnOrderId`) throws before anything is written, so a corrected
 * re-delivery can still succeed.
 */
export async function ingestWalmartReturn(payload: unknown, source: 'webhook' | 'poll'): Promise<{ created: boolean }> {
  const p = payload as any
  const returnOrderId: unknown = p?.returnOrderId
  if (typeof returnOrderId !== 'string' || !returnOrderId) {
    throw new ChannelError('unmappable_return', 'missing returnOrderId')
  }
  // A malformed purchaseOrderId (present but not a string) is treated the
  // same as one we don't recognise -- undefined here, so the lookup below is
  // skipped rather than handed a non-string to Prisma's `where`, which would
  // throw a raw validation error the poller's ChannelError-only catch cannot
  // see, aborting the whole sweep instead of skipping this one return.
  const purchaseOrderIdRaw: unknown = p?.customerOrderInfo?.purchaseOrderId ?? p?.purchaseOrderId
  const purchaseOrderId: string | undefined = typeof purchaseOrderIdRaw === 'string' && purchaseOrderIdRaw ? purchaseOrderIdRaw : undefined
  // Walmart sends this amount in DOLLARS (e.g. 105.98), not cents. Only its
  // sign is used here -- nothing below stores or sums it.
  const refundedAmountDollars = Number(p?.refundedAmount?.amount)
  const hasRealRefund = Number.isFinite(refundedAmountDollars) && refundedAmountDollars > 0

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

      if (order && order.status === 'fulfilled' && hasRealRefund) {
        try {
          await refundInTx(tx, order, 'system')
        } catch (e) {
          if (!(e instanceof OrderError && e.code === 'invalid_transition')) throw e
        }
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
 * itself computed the refundable lines. Not idempotency-guarded against a
 * repeated call the way ingestion is -- this is a direct, explicit operator
 * action (a POST with an empty body), not something a re-delivered event
 * could trigger twice -- but it moves money, so it leaves a record: a
 * `walmart_refund_issued` audit row, written only after Walmart accepts the
 * request. A failed request (network error, Walmart rejects it) throws
 * before the audit write, deliberately: an audit row here means "we
 * successfully asked Walmart for this refund," not "we attempted to."
 */
export async function issueWalmartRefund(returnOrderId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  await client.request('POST', `/v3/returns/${returnOrderId}/refund`, { body: {} })
  await recordAudit({
    actorId: 'system',
    action: 'walmart_refund_issued',
    target: `walmart_return:${returnOrderId}`,
    after: { returnOrderId },
  })
}

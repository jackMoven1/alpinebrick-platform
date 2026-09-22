// Order acknowledgement, shipment push, and seller-initiated cancel.
//
// Task 5 (orders.ingest.ts) already enqueues `walmart_ack_order` inside the
// ingest transaction, via `enqueueIdempotentJob`, every time an order is
// ingested. Until this file registers a handler for that job type, every
// enqueued ack throws "no handler registered for job type walmart_ack_order"
// out of `processDueJobs`, retries five times, and dead-letters -- Walmart is
// never told we received the order. `registerShippingHandlers` is the
// missing handler; nothing else about the ack path changes.
//
// v1 scope: whole-order operations only. `recordChannelShipment` and
// `cancelChannelOrder` both operate on the entire order -- there is no
// partial-shipment or partial-cancellation support here. A caller cannot
// ship or cancel a subset of an order's lines; that would need per-line
// shipment/cancellation state on OrderLine (a shippedQuantity /
// cancelledQuantity column, e.g.), which does not exist on the schema this
// task inherited. Building it was out of scope for this task and is not
// attempted here.
//
// Walmart-initiated cancels (buyer cancels, Walmart ops cancels) arrive
// through the existing poller/webhook as an order-status change and are
// handled manually today -- v1 only codes the seller-initiated cancel path
// (`cancelChannelOrder`), matching the brief.
import { prisma } from '../../prisma.js'
import { fulfillOrder, cancelOrder } from '../../orders/orders.service.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toShipPayload } from './mappers.js'
import { enqueueIdempotentJob, registerHandler } from './outbox.js'
import { ChannelError } from './orders.ingest.js'

/**
 * Record a Walmart shipment against a paid Walmart order: moves stock via
 * Plan 2's `fulfillOrder` (a conditional UPDATE inside a transaction --
 * decrements on_hand and reserved together, guarded by the affected-row
 * count, exactly like every other stock movement in this codebase; see
 * orders.service.ts) and schedules the outbound shipping push IN THAT SAME
 * TRANSACTION, via `fulfillOrder`'s `inTransaction` hook.
 *
 * Atomicity (final fix wave A1): the `walmart_ship_order` job commits with
 * the status change or not at all. It used to be enqueued after
 * `fulfillOrder` committed (and after its post-commit inventory pushes), so
 * a throw or crash in between left a fulfilled order with no ship job -- and
 * a retry was refused by the guard below, so recovery was manual. Now a
 * failed job insert rolls the fulfilment back (the order stays `paid` and
 * the call can simply be retried), and nothing after commit can stop the job
 * from existing.
 *
 * `enqueueIdempotentJob`, not `enqueueJob`: this runs inside a transaction,
 * where `enqueueJob`'s P2002 catch-and-recover would poison it (25P02 -- see
 * enqueueIdempotentJob's doc comment in outbox.ts). `ship:<orderId>` is a
 * one-shot key -- an order ships once -- so it is never released at pickup
 * either (see `processDueJobs`).
 *
 * Idempotency: the guard below (`order.channel !== 'walmart' || order.status
 * !== 'paid'`) is what makes a second call safe. The first call moves the
 * order to `fulfilled`; a second call sees a non-'paid' order and throws
 * `not_shippable` before `fulfillOrder` runs -- stock cannot be decremented
 * twice and at most one `walmart_ship_order` job is ever created per order.
 * Two calls racing past that guard are settled by `fulfillOrder`'s own
 * status check and conditional UPDATE (the loser throws and rolls back,
 * taking its job insert with it); the one-shot dedupeKey is a further line
 * of defence.
 */
export async function recordChannelShipment(
  orderId: string,
  input: { carrier: string; trackingNumber: string; trackingUrl?: string },
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart' || order.status !== 'paid') {
    throw new ChannelError('not_shippable', `order ${orderId} is not a paid walmart order`)
  }
  await fulfillOrder(orderId, 'system', {
    inTransaction: (tx) => enqueueIdempotentJob('walmart_ship_order', { orderId, ...input }, `ship:${orderId}`, tx),
  })
}

/**
 * Seller-initiated cancel of a Walmart order: releases the reservation via
 * Plan 2's `cancelOrder` (same conditional-UPDATE-inside-a-transaction
 * pattern as `fulfillOrder` -- see orders.service.ts) and schedules the
 * outbound cancel push in that same transaction, exactly as
 * `recordChannelShipment` does for shipping (final fix wave A1): a failed
 * job insert rolls the cancel back; nothing after commit can stop the job
 * from existing. `cancel:<orderId>` is one-shot.
 *
 * Idempotency: `cancelOrder` itself is the guard here -- it only accepts a
 * `pending` or `paid` order and throws `OrderError('invalid_transition')`
 * otherwise, so a second `cancelChannelOrder(orderId)` call against an
 * already-cancelled (or already-fulfilled) order fails before its conditional
 * UPDATE runs, never releasing the same reservation twice, and rolls back
 * before any job insert.
 */
export async function cancelChannelOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart') {
    throw new ChannelError('not_walmart', `order ${orderId} is not a walmart order`)
  }
  await cancelOrder(orderId, 'system', {
    inTransaction: (tx) => enqueueIdempotentJob('walmart_cancel_order', { orderId }, `cancel:${orderId}`, tx),
  })
}

/**
 * Order lines in the order `ingestWalmartOrder` created them (final fix wave
 * B2). Without an orderBy, Postgres returns rows in physical order, which an
 * ordinary UPDATE of a line changes (the new row version lands elsewhere in
 * the heap) -- and the position-derived Walmart line numbers above would
 * then ship or cancel the wrong line's quantity.
 *
 * Ordered by `id`: OrderLine has no created-at or position column, and its
 * `id` is a Prisma `cuid()` -- 'c' + millisecond timestamp + per-process
 * counter, both fixed-width base36 -- so ids sort in generation order.
 * Ingest creates every line of an order in one nested `lines.create` array,
 * in `canonical.lines` order (which is Walmart's orderLine array order), and
 * Prisma generates the ids in that array order within one process. Caveat:
 * the 4-char counter wraps every ~1.68M ids, so an order whose lines straddle
 * a wrap in the same millisecond would sort out of order; negligible, but it
 * is why this is ordering by proxy.
 *
 * The real fix is to store Walmart's own `lineNumber` on OrderLine at ingest
 * and send that back -- on the launch checklist
 * (docs/status/2026-09-22-walmart-launch-checklist.md).
 */
const LINES_IN_INGEST_ORDER = { lines: { orderBy: { id: 'asc' as const } } }

export function registerShippingHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_ack_order', async (p) => {
    await client.request('POST', `/v3/orders/${p.externalOrderId}/acknowledge`)
  })

  registerHandler('walmart_ship_order', async (p) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: LINES_IN_INGEST_ORDER })
    // Walmart line numbers are 1-based strings in original order; we store
    // nothing extra to remember them, so the i-th order line maps to
    // lineNumber String(i+1) by position, both here and in the cancel
    // handler below. That only holds if the lines come back in the order
    // ingest created them -- see LINES_IN_INGEST_ORDER.
    const lineNumbers = order.lines.map((_, i) => String(i + 1))
    const quantityByLine = Object.fromEntries(order.lines.map((l, i) => [String(i + 1), l.quantity]))
    await client.request('POST', `/v3/orders/${order.externalOrderId}/shipping`, {
      body: toShipPayload({
        lineNumbers,
        quantityByLine,
        carrier: p.carrier,
        trackingNumber: p.trackingNumber,
        trackingUrl: p.trackingUrl,
        shipDateIso: new Date().toISOString(),
      }),
    })
  })

  registerHandler('walmart_cancel_order', async (p) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: LINES_IN_INGEST_ORDER })
    await client.request('POST', `/v3/orders/${order.externalOrderId}/cancel`, {
      body: {
        orderCancellation: {
          orderLines: {
            orderLine: order.lines.map((l, i) => ({
              lineNumber: String(i + 1),
              orderLineStatuses: {
                orderLineStatus: [{
                  status: 'Cancelled',
                  cancellationReason: 'SELLER_CANCEL',
                  statusQuantity: { unitOfMeasurement: 'EACH', amount: String(l.quantity) },
                }],
              },
            })),
          },
        },
      },
    })
  })
}

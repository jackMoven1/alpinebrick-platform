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
import { enqueueJob, registerHandler } from './outbox.js'
import { ChannelError } from './orders.ingest.js'

/**
 * Record a Walmart shipment against a paid Walmart order: moves stock via
 * Plan 2's `fulfillOrder` (a conditional UPDATE inside a transaction --
 * decrements on_hand and reserved together, guarded by the affected-row
 * count, exactly like every other stock movement in this codebase; see
 * orders.service.ts) and then schedules the outbound shipping push.
 *
 * Idempotency: the guard below (`order.channel !== 'walmart' || order.status
 * !== 'paid'`) is what makes a second call safe, not just the job's
 * dedupeKey. The first call moves the order to `fulfilled`; a second call
 * against the same orderId sees a non-'paid' order and throws
 * `not_shippable` before `fulfillOrder` (and therefore the stock UPDATE) or
 * `enqueueJob` ever runs -- stock cannot be decremented twice and at most one
 * `walmart_ship_order` job is ever created per order. The dedupeKey
 * (`ship:<orderId>`) is a second line of defence against a caller racing two
 * concurrent `recordChannelShipment` calls for the same order: only one can
 * win `fulfillOrder`'s conditional UPDATE (the other throws
 * `inventory_conflict` from `fulfillOrder` itself), so in practice the guard
 * above already prevents the race from reaching `enqueueJob` twice.
 */
export async function recordChannelShipment(
  orderId: string,
  input: { carrier: string; trackingNumber: string; trackingUrl?: string },
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart' || order.status !== 'paid') {
    throw new ChannelError('not_shippable', `order ${orderId} is not a paid walmart order`)
  }
  await fulfillOrder(orderId)
  await enqueueJob('walmart_ship_order', { orderId, ...input }, { dedupeKey: `ship:${orderId}` })
}

/**
 * Seller-initiated cancel of a Walmart order: releases the reservation via
 * Plan 2's `cancelOrder` (same conditional-UPDATE-inside-a-transaction
 * pattern as `fulfillOrder` -- see orders.service.ts) and schedules the
 * outbound cancel push.
 *
 * Idempotency: `cancelOrder` itself is the guard here -- it only accepts a
 * `pending` or `paid` order and throws `OrderError('invalid_transition')`
 * otherwise, so a second `cancelChannelOrder(orderId)` call against an
 * already-cancelled (or already-fulfilled) order fails before its conditional
 * UPDATE runs, never releasing the same reservation twice. The dedupeKey
 * (`cancel:<orderId>`) again only matters for two concurrent calls racing
 * each other; `cancelOrder`'s own affected-row check already makes that race
 * safe (the loser's UPDATE matches 0 rows and throws `inventory_conflict`).
 */
export async function cancelChannelOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart') {
    throw new ChannelError('not_walmart', `order ${orderId} is not a walmart order`)
  }
  await cancelOrder(orderId)
  await enqueueJob('walmart_cancel_order', { orderId }, { dedupeKey: `cancel:${orderId}` })
}

export function registerShippingHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_ack_order', async (p) => {
    await client.request('POST', `/v3/orders/${p.externalOrderId}/acknowledge`)
  })

  registerHandler('walmart_ship_order', async (p) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { lines: true } })
    // Walmart line numbers are 1-based strings in original order; we store
    // nothing extra to remember them, so the i-th order line maps to
    // lineNumber String(i+1) by position, both here and in the cancel
    // handler below.
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
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { lines: true } })
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

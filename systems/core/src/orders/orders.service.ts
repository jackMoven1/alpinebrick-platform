import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import { createFlatRateTaxPort } from '../ports/tax/flat-rate.adapter.js'
import { enqueueInventoryPush } from '../channels/walmart/inventory.sync.js'

export class OrderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

export interface OrderLineDto {
  variantId: string
  sku: string
  quantity: number
  unitPriceCents: number
  lineSubtotalCents: number
  discountCents: number
}

export interface OrderDto {
  id: string
  orderNumber: string
  status: string
  email: string
  shipToState: string
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
  taxRateBps: number
  taxJurisdiction: string
  lines: OrderLineDto[]
}

export interface PlaceOrderInput {
  email: string
  shipToState: string
  lines: { variantId: string; quantity: number }[]
  actorId?: string
}

const defaultTaxPort = createFlatRateTaxPort()

/**
 * Options for a status transition that a channel needs to extend atomically.
 *
 * `inTransaction` runs INSIDE the transition's `$transaction`, after the
 * stock UPDATEs, the status change and the audit row -- so whatever it
 * writes commits or rolls back together with them, and a throw from it rolls
 * the whole transition back. Walmart's ship/cancel paths (shipping.ts) use it
 * to enqueue their outbound job in the same transaction as the status change
 * (final fix wave A1): enqueued after commit, a crash in between left a
 * fulfilled/cancelled order with no job, and the status guard refused the
 * retry. Anything written through `tx` must not raise on an expected
 * condition -- Postgres aborts the whole transaction on the first statement
 * error (see enqueueIdempotentJob in channels/walmart/outbox.ts).
 */
export interface TransitionOptions {
  inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>
}

/**
 * Post-commit Walmart inventory pushes. The transaction has already
 * committed when this runs, so a failure to ENQUEUE a push must not surface
 * as a failure of the order operation: the order exists and stock moved,
 * and an error here would turn a successful checkout into an HTTP 500 (and
 * invite a duplicate order), or make a ship/cancel look failed when a retry
 * is refused by the status guard. The push is recurring and recovers via the
 * hourly reconcile (final fix wave B4), so it is logged instead. Each line is
 * attempted even if an earlier one fails.
 */
async function enqueueInventoryPushesAfterCommit(
  variantIds: string[],
  context: string,
): Promise<void> {
  for (const variantId of variantIds) {
    try {
      await enqueueInventoryPush(variantId)
    } catch (e) {
      console.error(`orders: post-commit inventory push enqueue failed (${context}, variant ${variantId}):`, e)
    }
  }
}

export function orderNumber(n: number): string {
  return `ABE-${String(n).padStart(6, '0')}`
}

function toDto(o: any): OrderDto {
  return {
    id: o.id,
    orderNumber: orderNumber(o.number),
    status: o.status,
    email: o.email,
    shipToState: o.shipToState,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    taxRateBps: o.taxRateBps,
    taxJurisdiction: o.taxJurisdiction,
    lines: o.lines.map((l: any) => ({
      variantId: l.variantId, sku: l.sku, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
      discountCents: l.discountCents,
    })),
  }
}

export async function placeOrder(input: PlaceOrderInput, taxPort: TaxPort = defaultTaxPort): Promise<OrderDto> {
  if (input.lines.length === 0) throw new OrderError('empty_order', 'order must have at least one line')
  const actorId = input.actorId ?? 'system'

  const order = await prisma.$transaction(async (tx) => {
    // 1. Resolve every line against a published variant; snapshot price + sku.
    const resolved: { variantId: string; sku: string; quantity: number; unitPriceCents: number }[] = []
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new OrderError('invalid_quantity', `quantity must be a positive integer for variant ${line.variantId}`)
      }
      const variant = await tx.variant.findFirst({
        where: { id: line.variantId, product: { status: 'published' } },
      })
      if (!variant) throw new OrderError('variant_not_found', `no published variant ${line.variantId}`)
      resolved.push({ variantId: variant.id, sku: variant.sku, quantity: line.quantity, unitPriceCents: variant.priceCents })
    }

    // 2. Reserve each line atomically: only reserve if enough is available RIGHT
    //    NOW. Units allocated to Walmart are not the storefront's to sell
    //    (spec §5.1 rule 1).
    for (const line of resolved) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${line.variantId}
          AND on_hand - reserved - COALESCE(walmart_allocation, 0) >= ${line.quantity}`
      if (affected === 0) throw new OrderError('insufficient_stock', `not enough stock for variant ${line.variantId}`)
    }

    // 3. Compute money from the snapshot; tax comes from the port.
    //    Tax base is the DISCOUNTED subtotal (Jack, 2026-08-11 — see Task 2), so
    //    each amountCents passed to the port must be net of that line's discount.
    //    This plan has no discount input, so every discount is 0 and the
    //    arithmetic is identical; the shape is written the correct way so the plan
    //    that introduces discounts changes values, not structure.
    const subtotalCents = resolved.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0)
    const discountCents = 0
    const tax = await taxPort.computeTax({
      shipToState: input.shipToState,
      // When discounts exist, subtract that line's discountCents here.
      lineItems: resolved.map((l) => ({ amountCents: l.unitPriceCents * l.quantity })),
    })

    const created = await tx.order.create({
      data: {
        email: input.email,
        shipToState: input.shipToState.trim().toUpperCase(),
        status: 'pending',
        subtotalCents,
        discountCents,
        taxCents: tax.taxCents,
        totalCents: subtotalCents - discountCents + tax.taxCents,
        taxRateBps: tax.rateBps,
        taxJurisdiction: tax.jurisdiction,
        lines: {
          create: resolved.map((l) => ({
            variantId: l.variantId, sku: l.sku, quantity: l.quantity,
            unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.unitPriceCents * l.quantity,
          })),
        },
      },
      include: { lines: true },
    })

    await recordAudit({
      actorId, action: 'order.place', target: `order:${created.id}`,
      after: { status: created.status, totalCents: created.totalCents },
    }, tx)

    return created
  })

  await enqueueInventoryPushesAfterCommit(order.lines.map((l) => l.variantId), `order.place order:${order.id}`)

  return toDto(order)
}

export async function getOrder(id: string): Promise<OrderDto | null> {
  const o = await prisma.order.findUnique({ where: { id }, include: { lines: true } })
  return o ? toDto(o) : null
}

async function loadOrderForUpdate(tx: any, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  return order
}

export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending') {
      throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
    }
    const next = await tx.order.update({ where: { id: orderId }, data: { status: 'paid' }, include: { lines: true } })
    await recordAudit({ actorId, action: 'order.paid', target: `order:${orderId}`, before: { status: 'pending' }, after: { status: 'paid' } }, tx)
    return next
  })
  return toDto(updated)
}

export async function fulfillOrder(orderId: string, actorId = 'system', opts: TransitionOptions = {}): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot fulfill a ${order.status} order`)
    }
    for (const line of order.lines) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET on_hand = on_hand - ${line.quantity}, reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity} AND on_hand >= ${line.quantity}`
      if (affected === 0) throw new OrderError('inventory_conflict', `cannot decrement stock for variant ${line.variantId}`)
    }
    const next = await tx.order.update({ where: { id: orderId }, data: { status: 'fulfilled' }, include: { lines: true } })
    await recordAudit({ actorId, action: 'order.fulfilled', target: `order:${orderId}`, before: { status: 'paid' }, after: { status: 'fulfilled' } }, tx)
    if (opts.inTransaction) await opts.inTransaction(tx)
    return next
  })
  await enqueueInventoryPushesAfterCommit(updated.lines.map((l: { variantId: string }) => l.variantId), `order.fulfilled order:${orderId}`)
  return toDto(updated)
}

export async function cancelOrder(orderId: string, actorId = 'system', opts: TransitionOptions = {}): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending' && order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot cancel a ${order.status} order`)
    }
    for (const line of order.lines) {
      // Guarded exactly as fulfillOrder is. Without the affected-row check the
      // UPDATE silently matches nothing when reserved has drifted below the line
      // quantity, the order still becomes cancelled, and the remaining hold is
      // stranded forever — stock that can never be sold again, with no error
      // raised. Failing loudly here is recoverable; the silent version is not.
      //
      // A Walmart unit that did not sell stays Walmart's (spec §5.1 rule 3):
      // reserved - q and allocation + q keeps reserved + allocation constant,
      // so the invariant holds.
      const affected = order.channel === 'walmart'
        ? await tx.$executeRaw`
            UPDATE inventory
            SET reserved = reserved - ${line.quantity},
                walmart_allocation = CASE WHEN walmart_allocation IS NULL THEN NULL
                                          ELSE walmart_allocation + ${line.quantity} END
            WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
        : await tx.$executeRaw`
            UPDATE inventory SET reserved = reserved - ${line.quantity}
            WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
      if (affected === 0) throw new OrderError('inventory_conflict', `cannot release reservation for variant ${line.variantId}`)
    }
    const next = await tx.order.update({ where: { id: orderId }, data: { status: 'cancelled' }, include: { lines: true } })
    await recordAudit({ actorId, action: 'order.cancelled', target: `order:${orderId}`, after: { status: 'cancelled' } }, tx)
    if (opts.inTransaction) await opts.inTransaction(tx)
    return next
  })
  await enqueueInventoryPushesAfterCommit(updated.lines.map((l: { variantId: string }) => l.variantId), `order.cancelled order:${orderId}`)
  return toDto(updated)
}

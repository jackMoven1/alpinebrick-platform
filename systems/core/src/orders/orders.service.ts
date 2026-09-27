import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import { createFlatRateTaxPort } from '../ports/tax/flat-rate.adapter.js'
import { enqueueInventoryPush } from '../channels/walmart/inventory.sync.js'
import { storefrontSellable } from '../inventory/allocation.js'

export class OrderError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'OrderError'
  }
}

/** A pending checkout order's email until Stripe's webhook writes the real one (spec §3). */
export const PENDING_CHECKOUT_EMAIL = 'pending@checkout.invalid'

export type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>

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
  /** The storefront checkbox as submitted; applied to the Customer at payment. */
  marketingOptIn?: boolean
  /** Snapshotted now; partner and rate are resolved by the webhook at payment. */
  referral?: { code: string; firstSeenAt: Date } | null
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
  /**
   * Cancel only if the locked order is still `pending` (fix round 1, ruling
   * T8-R1). Every storefront-initiated cancel races a possible
   * pending->paid webhook write: without this, cancelOrderTx's guard (which
   * also accepts `paid`) would happily cancel an order Stripe just took
   * money for. When set and the order is not `pending`, the transition is a
   * pure no-op -- no update, no stock release, no audit row -- and the Tx
   * variant returns `null` so the caller can tell a real cancel from a
   * skip. Walmart's cancel (channels/walmart/shipping.ts) legitimately
   * cancels a `paid` order, so it leaves this unset.
   */
  onlyIfPending?: boolean
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
export async function enqueueInventoryPushesAfterCommit(
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
      if (!variant) throw new OrderError('variant_not_found', `no published variant ${line.variantId}`, { variantId: line.variantId })
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
      if (affected === 0) {
        // The UPDATE matched nothing (not an error), so the transaction is
        // still usable: read what IS available so the storefront can say
        // "Only N left" instead of a bare failure.
        const row = await tx.inventory.findUnique({ where: { variantId: line.variantId } })
        const available = row ? storefrontSellable(row.onHand, row.reserved, row.walmartAllocation) : 0
        throw new OrderError('insufficient_stock', `not enough stock for variant ${line.variantId}`, { variantId: line.variantId, available })
      }
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
        marketingOptIn: input.marketingOptIn ?? false,
        referralCode: input.referral?.code ?? null,
        referralFirstSeenAt: input.referral?.firstSeenAt ?? null,
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

/**
 * Row-locks the order for the rest of the transaction. Every transition
 * goes through here: without the lock, two transitions (the Stripe webhook's
 * paid and the sweep's cancel, say) can both read `pending` and both write,
 * leaving a paid order whose reservation was released. With it, the second
 * waits, then re-reads the committed status (READ COMMITTED takes a fresh
 * snapshot per statement) and refuses.
 */
export async function lockOrderRow(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines | null> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
  return tx.order.findUnique({ where: { id: orderId }, include: { lines: true } })
}

async function loadOrderForUpdate(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines> {
  const order = await lockOrderRow(tx, orderId)
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  return order
}

/** pending -> paid inside the caller's transaction. `data` is written with the status change. */
export async function markOrderPaidTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId = 'system',
  data: Prisma.OrderUncheckedUpdateInput = {},
): Promise<OrderWithLines> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (order.status !== 'pending') {
    throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
  }
  const next = await tx.order.update({ where: { id: orderId }, data: { ...data, status: 'paid' }, include: { lines: true } })
  await recordAudit({ actorId, action: 'order.paid', target: `order:${orderId}`, before: { status: 'pending' }, after: { status: 'paid' } }, tx)
  return next
}

export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  return toDto(await prisma.$transaction((tx) => markOrderPaidTx(tx, orderId, actorId)))
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

/**
 * Releases the still-held reservation for every line of `order`, inside the
 * caller's transaction. Shared by cancel and full refund so the release SQL
 * exists once. Returns the released variant ids, in line order.
 */
async function releaseReservation(tx: Prisma.TransactionClient, order: OrderWithLines): Promise<string[]> {
  const released: string[] = []
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
    released.push(line.variantId)
  }
  return released
}

/**
 * pending|paid -> cancelled inside the caller's transaction; releases the
 * reservation. `opts.onlyIfPending` skips the transition entirely (returns
 * `null`) when the locked order is not `pending` -- see TransitionOptions.
 */
export async function cancelOrderTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId = 'system',
  opts: TransitionOptions = {},
): Promise<OrderWithLines | null> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (opts.onlyIfPending && order.status !== 'pending') return null
  if (order.status !== 'pending' && order.status !== 'paid') {
    throw new OrderError('invalid_transition', `cannot cancel a ${order.status} order`)
  }
  await releaseReservation(tx, order)
  const next = await tx.order.update({ where: { id: orderId }, data: { status: 'cancelled' }, include: { lines: true } })
  await recordAudit({ actorId, action: 'order.cancelled', target: `order:${orderId}`, after: { status: 'cancelled' } }, tx)
  if (opts.inTransaction) await opts.inTransaction(tx)
  return next
}

/** `null` means `opts.onlyIfPending` skipped it (order was no longer pending) -- no pushes to enqueue. */
export async function cancelOrder(orderId: string, actorId = 'system', opts: TransitionOptions = {}): Promise<OrderDto | null> {
  const updated = await prisma.$transaction((tx) => cancelOrderTx(tx, orderId, actorId, opts))
  if (!updated) return null
  await enqueueInventoryPushesAfterCommit(updated.lines.map((l) => l.variantId), `order.cancelled order:${orderId}`)
  return toDto(updated)
}

/**
 * A Stripe refund (charge.refunded, spec §5). Partial: amount only. Full:
 * status `refunded`. A `paid` order (not yet shipped) also releases its
 * reservation; `fulfilled` and `cancelled` have no hold left to release.
 * Storefront only -- Walmart refunds go through returns.service.ts.
 */
export async function refundOrderTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  input: { refundedCents: number; full: boolean },
  actorId = 'system',
): Promise<{ order: OrderWithLines; releasedVariantIds: string[] }> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (order.channel !== 'storefront') {
    throw new OrderError('invalid_transition', `refunds for ${order.channel} orders are not handled here`)
  }
  const amount = input.refundedCents
  if (!Number.isInteger(amount) || amount < 0 || amount > order.totalCents) {
    throw new OrderError('invalid_refund', `refund amount ${amount} is not an integer between 0 and ${order.totalCents}`, {
      refundedCents: amount, totalCents: order.totalCents,
    })
  }
  const target = `order:${orderId}`
  const before = { status: order.status, refundedCents: order.refundedCents }
  // Stripe's amount_refunded is cumulative, but distinct charge.refunded
  // events can arrive out of order: an older, smaller figure must never lower
  // the amount (and, below, never downgrade a `refunded` status).
  const refundedCents = Math.max(order.refundedCents, amount)

  // Already fully refunded: nothing a later event says can change that, and
  // a repeat must not write a second audit row.
  if (order.status === 'refunded') return { order, releasedVariantIds: [] }

  if (!input.full) {
    if (refundedCents === order.refundedCents) return { order, releasedVariantIds: [] }
    const next = await tx.order.update({ where: { id: orderId }, data: { refundedCents }, include: { lines: true } })
    await recordAudit({ actorId, action: 'order.refund_partial', target, before, after: { status: next.status, refundedCents } }, tx)
    return { order: next, releasedVariantIds: [] }
  }

  if (order.status === 'pending') throw new OrderError('invalid_transition', 'cannot refund a pending order')

  // Same release as cancel (Ruling P6). Storefront-only here, so the Walmart
  // branch of the helper is never taken.
  const releasedVariantIds = order.status === 'paid' ? await releaseReservation(tx, order) : []
  const next = await tx.order.update({
    where: { id: orderId }, data: { status: 'refunded', refundedCents }, include: { lines: true },
  })
  await recordAudit({ actorId, action: 'order.refunded', target, before, after: { status: 'refunded', refundedCents } }, tx)
  return { order: next, releasedVariantIds }
}

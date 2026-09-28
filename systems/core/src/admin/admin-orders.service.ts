import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from './admin-errors.js'
import {
  fulfillOrder, cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../orders/orders.service.js'
import { lineName } from '../checkout/checkout.service.js'
import { isPaymentInFlight } from '../checkout/payment-attempt.js'

export const ORDER_TABS = ['to_ship', 'shipped', 'pending', 'closed', 'review'] as const
export type OrderTab = (typeof ORDER_TABS)[number]
export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other'] as const

/** Storefront only: Walmart orders ship through the Walmart flow. */
function tabWhere(tab: OrderTab): Prisma.OrderWhereInput {
  const storefront = { channel: 'storefront' as const }
  switch (tab) {
    case 'to_ship': return { ...storefront, status: 'paid' }
    case 'shipped': return { ...storefront, status: 'fulfilled' }
    case 'pending': return { ...storefront, status: 'pending' }
    case 'closed': return { ...storefront, status: { in: ['cancelled', 'refunded'] } }
    case 'review': return { ...storefront, reviewReason: { not: null } }
  }
}

const shownEmail = (email: string) => (email === PENDING_CHECKOUT_EMAIL ? null : email)

export interface AdminOrderRow {
  id: string; orderNumber: string; createdAt: Date; email: string | null; itemCount: number
  totalCents: number; shipToState: string | null; status: string; reviewReason: string | null
}

export async function listAdminOrders(q: { tab?: unknown; page?: number; pageSize?: number }) {
  if (typeof q.tab !== 'string' || !(ORDER_TABS as readonly string[]).includes(q.tab)) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { tab: `one of ${ORDER_TABS.join(', ')}` })
  }
  const page = q.page && q.page >= 1 ? q.page : 1
  const pageSize = q.pageSize && q.pageSize >= 1 && q.pageSize <= 100 ? q.pageSize : 25
  const where = tabWhere(q.tab as OrderTab)
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
      include: { lines: { select: { quantity: true } } },
    }),
  ])
  const items: AdminOrderRow[] = rows.map((o) => ({
    id: o.id, orderNumber: orderNumber(o.number), createdAt: o.createdAt, email: shownEmail(o.email),
    itemCount: o.lines.reduce((n, l) => n + l.quantity, 0), totalCents: o.totalCents,
    shipToState: o.shipToState || null, status: o.status, reviewReason: o.reviewReason,
  }))
  return { items, total, page, pageSize }
}

/**
 * The payment behind a paid order. `url` stays null until the Square
 * Dashboard deep-link format is confirmed in the sandbox (spec §9.3); `id`
 * lets the operator search for it meanwhile (plan decision 10).
 */
export interface AdminOrderPayment { provider: 'square'; id: string; url: string | null }

export interface AdminOrderDetail {
  id: string; orderNumber: string; channel: string; status: string; reviewReason: string | null
  createdAt: Date; paidAt: Date | null; shippedAt: Date | null
  email: string | null; marketingOptIn: boolean
  shipTo: { name: string | null; line1: string; line2: string | null; city: string | null; state: string; postalCode: string | null } | null
  lines: { variantId: string; sku: string; name: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number; refundedCents: number
  taxJurisdiction: string; taxRateBps: number
  carrier: string | null; trackingNumber: string | null
  referral: { code: string; partnerName: string | null; commissionRateBps: number | null; unmatched: boolean } | null
  payment: AdminOrderPayment | null
  audit: { action: string; actorName: string; createdAt: Date; after: unknown }[]
}

export async function getAdminOrder(id: string): Promise<AdminOrderDetail | null> {
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      affiliatePartner: { select: { name: true } },
      lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } },
    },
  })
  if (!o) return null
  const audit = await prisma.auditLog.findMany({
    where: { target: `order:${id}` }, orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } },
  })
  return {
    id: o.id, orderNumber: orderNumber(o.number), channel: o.channel, status: o.status, reviewReason: o.reviewReason,
    createdAt: o.createdAt, paidAt: o.paidAt, shippedAt: o.shippedAt,
    email: shownEmail(o.email), marketingOptIn: o.marketingOptIn,
    shipTo: o.shipLine1
      ? { name: o.shipName, line1: o.shipLine1, line2: o.shipLine2, city: o.shipCity, state: o.shipToState, postalCode: o.shipPostalCode }
      : null,
    lines: o.lines.map((l) => ({
      variantId: l.variantId, sku: l.sku, name: lineName(l.variant.product.name, l.variant.attributes),
      quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
    })),
    subtotalCents: o.subtotalCents, shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents,
    refundedCents: o.refundedCents, taxJurisdiction: o.taxJurisdiction, taxRateBps: o.taxRateBps,
    carrier: o.carrier, trackingNumber: o.trackingNumber,
    referral: o.referralCode
      ? { code: o.referralCode, partnerName: o.affiliatePartner?.name ?? null, commissionRateBps: o.commissionRateBps, unmatched: o.referralUnmatched }
      : null,
    payment: o.squarePaymentId ? { provider: 'square', id: o.squarePaymentId, url: null } : null,
    audit: audit.map((a) => ({ action: a.action, actorName: a.actor.name, createdAt: a.createdAt, after: a.after })),
  }
}

function mapOrderError(err: unknown): unknown {
  if (!(err instanceof OrderError)) return err
  if (err.code === 'order_not_found') return new AdminError('NOT_FOUND', 'order not found')
  if (err.code === 'inventory_conflict') return new AdminError('INVENTORY_CONFLICT', 'stock no longer matches this order; check the variant before retrying')
  return new AdminError('INVALID_TRANSITION', err.message)
}

async function requireStorefrontOrder(id: string) {
  const order = await prisma.order.findUnique({
    where: { id }, select: { channel: true, status: true, reviewReason: true, paymentAttemptAt: true },
  })
  if (!order) throw new AdminError('NOT_FOUND', 'order not found')
  if (order.channel !== 'storefront') throw new AdminError('WRONG_CHANNEL', 'Walmart orders are handled through the Walmart flow')
  return order
}

const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/

function parseShipInput(body: unknown): { carrier: (typeof CARRIERS)[number]; trackingNumber: string | null; acknowledgeReview: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (!['carrier', 'trackingNumber', 'acknowledgeReview'].includes(k)) fields[k] = 'unknown field'
  const carrier = b.carrier
  if (typeof carrier !== 'string' || !(CARRIERS as readonly string[]).includes(carrier)) fields.carrier = 'USPS, UPS, FedEx or Other'
  const tracking = typeof b.trackingNumber === 'string' ? b.trackingNumber.trim() : ''
  if (b.trackingNumber !== undefined && b.trackingNumber !== null && typeof b.trackingNumber !== 'string') fields.trackingNumber = 'text'
  else if (tracking === '' && carrier !== 'Other') fields.trackingNumber = 'required unless the carrier is Other'
  else if (tracking !== '' && !TRACKING_RE.test(tracking)) fields.trackingNumber = 'letters, numbers, spaces and hyphens, at most 64'
  if ('acknowledgeReview' in b && typeof b.acknowledgeReview !== 'boolean') fields.acknowledgeReview = 'true or false'
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
  return { carrier: carrier as (typeof CARRIERS)[number], trackingNumber: tracking || null, acknowledgeReview: b.acknowledgeReview === true }
}

function reviewRequired(reviewReason: string, verb: string) {
  return new AdminError('REVIEW_REQUIRED', `This order is flagged (${reviewReason}). Confirm you have reviewed it before ${verb}.`, undefined, { reviewReason })
}

/**
 * Mark shipped: `paid` only -> fulfillOrder, with carrier details in the same transaction.
 * The unlocked pre-read gives a fast refusal; the authoritative review check
 * re-reads under fulfillOrder's row lock (ruling F-R3).
 */
export async function shipOrder(id: string, body: unknown, actorId: string): Promise<AdminOrderDetail> {
  const input = parseShipInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.reviewReason && !input.acknowledgeReview) throw reviewRequired(order.reviewReason, 'shipping')
  try {
    await fulfillOrder(id, actorId, {
      inTransaction: async (tx) => {
        const locked = await tx.order.findUniqueOrThrow({ where: { id }, select: { reviewReason: true } })
        if (locked.reviewReason && !input.acknowledgeReview) throw reviewRequired(locked.reviewReason, 'shipping')
        await tx.order.update({ where: { id }, data: { shippedAt: new Date(), carrier: input.carrier, trackingNumber: input.trackingNumber } })
        await recordAudit({
          actorId, action: 'order.ship', target: `order:${id}`,
          after: { carrier: input.carrier, trackingNumber: input.trackingNumber, ...(locked.reviewReason ? { acknowledgedReview: locked.reviewReason } : {}) },
        }, tx)
      },
    })
  } catch (err) { throw mapOrderError(err) }
  return (await getAdminOrder(id))!
}

/** The order is no longer pending by the time the lock was taken: it was paid. */
function orderPaidError() {
  return new AdminError('ORDER_PAID', 'The customer has just paid for this order. Refresh the page; refund it in the payment dashboard if it should not ship.')
}

/** Plan decision 7: a charge may be landing; the sweep releases the order later if not. */
function paymentInProgressError() {
  return new AdminError('PAYMENT_IN_PROGRESS', 'The customer is paying for this order right now. Wait ten minutes, then refresh.')
}

function parseCancelInput(body: unknown): { acknowledgeReview: boolean } {
  if (body === undefined || body === null) return { acknowledgeReview: false }
  if (typeof body !== 'object' || Array.isArray(body)) throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (k !== 'acknowledgeReview') fields[k] = 'unknown field'
  if ('acknowledgeReview' in b && typeof b.acknowledgeReview !== 'boolean') fields.acknowledgeReview = 'true or false'
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
  return { acknowledgeReview: b.acknowledgeReview === true }
}

/**
 * Cancel: `pending` orders, plus (ruling F-R1) a `paid` order under dispute.
 * Every other paid order is refunded in the payment dashboard, never
 * cancelled here. There is no provider session to close any more (spec
 * 2026-09-28 §2): the pending cancel is ours alone, under the row lock,
 * refused while a payment attempt is in flight or a Square payment id is
 * already recorded (ruling Q-P6, extended to squarePaymentId the same way
 * the sweep is -- Q-P7), and onlyIfPending so a payment that landed first is
 * reported rather than undone.
 */
export async function cancelPendingOrder(id: string, body: unknown, actorId: string): Promise<AdminOrderDetail> {
  const input = parseCancelInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.status === 'paid' && order.reviewReason === 'disputed') {
    if (!input.acknowledgeReview) throw reviewRequired(order.reviewReason, 'cancelling')
    await cancelDisputedOrder(id, actorId)
    return (await getAdminOrder(id))!
  }
  if (order.status !== 'pending') {
    throw new AdminError('INVALID_TRANSITION', `cannot cancel a ${order.status} order here; refund paid orders in the payment dashboard`)
  }
  const now = new Date()
  let cancelled
  try {
    cancelled = await prisma.$transaction(async (tx) => {
      const locked = await lockOrderRow(tx, id)
      if (!locked) throw new OrderError('order_not_found', `no order ${id}`)
      if (locked.status === 'pending' && (locked.squarePaymentId || isPaymentInFlight(locked, now))) throw paymentInProgressError()
      return cancelOrderTx(tx, id, actorId, { onlyIfPending: true })
    })
  } catch (err) { throw mapOrderError(err) }
  if (!cancelled) throw orderPaidError()
  await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `order.cancelled order:${id}`)
  return (await getAdminOrder(id))!
}

/**
 * paid + disputed -> cancelled, releasing the reservation (ruling F-R1).
 * Deliberately WITHOUT onlyIfPending -- the order is paid. The unlocked
 * pre-read is re-checked under the row lock.
 */
async function cancelDisputedOrder(id: string, actorId: string): Promise<void> {
  let cancelled
  try {
    cancelled = await prisma.$transaction(async (tx) => {
      const locked = await lockOrderRow(tx, id)
      if (!locked) throw new OrderError('order_not_found', `no order ${id}`)
      if (locked.status !== 'paid' || locked.reviewReason !== 'disputed') {
        throw new OrderError('invalid_transition', `this order is now ${locked.status}${locked.reviewReason ? ` (${locked.reviewReason})` : ''}; refresh the page`)
      }
      return cancelOrderTx(tx, id, actorId, { auditAfter: { acknowledgedReview: locked.reviewReason } })
    })
  } catch (err) { throw mapOrderError(err) }
  if (cancelled) await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `order.cancelled (disputed) order:${id}`)
}

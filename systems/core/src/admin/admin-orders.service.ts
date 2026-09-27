import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from './admin-errors.js'
import {
  fulfillOrder, cancelOrder, cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../orders/orders.service.js'
import { lineName } from '../checkout/checkout.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'

export const ORDER_TABS = ['to_ship', 'shipped', 'pending', 'closed', 'review'] as const
export type OrderTab = (typeof ORDER_TABS)[number]
export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other'] as const

/** Storefront only: Walmart orders ship through the Walmart flow (plan decision 3). */
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
  stripePaymentUrl: string | null
  audit: { action: string; actorName: string; createdAt: Date; after: unknown }[]
}

export async function getAdminOrder(id: string, payments: Pick<PaymentsPort, 'livemode'>): Promise<AdminOrderDetail | null> {
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
  const pi = o.stripePaymentIntentId
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
    stripePaymentUrl: pi ? `https://dashboard.stripe.com/${payments.livemode ? '' : 'test/'}payments/${pi}` : null,
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
    where: { id }, select: { channel: true, status: true, reviewReason: true, stripeCheckoutSessionId: true },
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
 * Mark shipped (spec §7): `paid` only -> fulfillOrder, with carrier details in the same transaction.
 *
 * The unlocked pre-read gives a fast refusal, but it is only advisory: a
 * dispute webhook can flag the order between it and fulfillOrder's row lock.
 * The authoritative check re-reads reviewReason inside fulfillOrder's
 * transaction, under that lock (ruling F-R3), and the audit records the
 * locked value -- a throw there rolls the whole ship back.
 */
export async function shipOrder(id: string, body: unknown, actorId: string, payments: Pick<PaymentsPort, 'livemode'>): Promise<AdminOrderDetail> {
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
  return (await getAdminOrder(id, payments))!
}

/** Shared "the order is no longer pending" refusal for cancel (spec: refund paid orders in Stripe instead). */
function orderPaidError() {
  return new AdminError('ORDER_PAID', 'The customer has just paid for this order. Refresh the page; refund it in Stripe if it should not ship.')
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
 * Cancel (spec §7): `pending` orders, plus -- ruling F-R1 -- a `paid` order
 * under dispute, whose stock would otherwise stay reserved forever (a lost
 * dispute never sends charge.refunded). Every other paid order is refunded
 * in Stripe, never cancelled here.
 *
 * Pending: expire the Stripe session FIRST, so the customer cannot pay for
 * stock this is about to release. `cancelOrder` is called with
 * `{ onlyIfPending: true }` (ruling T8-R1): even after the checks above, a
 * webhook can still mark the order paid in the tiny window between the
 * Stripe expire call and cancelOrder's own row lock. A `null` result means
 * that race happened -- the order was no longer pending by the time the lock
 * was taken -- and is reported the same way as the synchronous "customer
 * paid in the meantime" case.
 */
export async function cancelPendingOrder(id: string, body: unknown, actorId: string, payments: PaymentsPort): Promise<AdminOrderDetail> {
  const input = parseCancelInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.status === 'paid' && order.reviewReason === 'disputed') {
    if (!input.acknowledgeReview) throw reviewRequired(order.reviewReason, 'cancelling')
    await cancelDisputedOrder(id, actorId)
    return (await getAdminOrder(id, payments))!
  }
  if (order.status !== 'pending') {
    throw new AdminError('INVALID_TRANSITION', `cannot cancel a ${order.status} order here; refund paid orders in the Stripe dashboard`)
  }
  if (order.stripeCheckoutSessionId) {
    let outcome: 'expired' | 'complete'
    try {
      outcome = await payments.expireCheckoutSession(order.stripeCheckoutSessionId)
    } catch (err) {
      console.error('[admin-orders] could not expire session', id, scrubError(err))
      throw new AdminError('STRIPE_UNAVAILABLE', 'Could not reach Stripe to close this checkout. Try again in a minute.')
    }
    if (outcome === 'complete') throw orderPaidError()
  }
  let cancelled
  try {
    cancelled = await cancelOrder(id, actorId, { onlyIfPending: true })
  } catch (err) { throw mapOrderError(err) }
  if (!cancelled) throw orderPaidError()
  return (await getAdminOrder(id, payments))!
}

/**
 * paid + disputed -> cancelled, releasing the reservation (ruling F-R1). The
 * normal cancel path, deliberately WITHOUT onlyIfPending -- the order is
 * paid. The unlocked pre-read is re-checked under the row lock: if a refund
 * or a ship landed in between, the order is no longer a disputed paid order
 * and this refuses instead of releasing stock twice or cancelling a shipment.
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

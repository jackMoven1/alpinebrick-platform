import { prisma } from '../prisma.js'
import {
  placeOrder, cancelOrder, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL, type OrderDto,
} from '../orders/orders.service.js'
import { deferredTaxAdapter } from '../ports/tax/deferred.adapter.js'
import { storefrontSellable } from '../inventory/allocation.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort, CheckoutSessionRef } from '../ports/payments/payments.port.js'
import type { ShippingPort } from '../ports/shipping/shipping.port.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, type CheckoutRequest } from './checkout-input.js'

export interface CheckoutDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  /** STOREFRONT_PUBLIC_URL, no trailing slash. null = checkout unavailable. */
  storefrontUrl: string | null
  now?: () => Date
}

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

export const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{1,250}$/

const unavailable = () =>
  new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.', 503)

function stockError(lines: LineProblem[]): CheckoutError {
  const code = lines[0].code
  const message = code === 'insufficient_stock'
    ? 'Some items are not available in the quantity requested.'
    : 'Some items are no longer available.'
  return new CheckoutError(code, message, 409, { lines })
}

/** "Brick Builder Set — Sealed" when the variant has attribute values, else the product name. */
export function lineName(productName: string, attributes: unknown): string {
  const values = attributes && typeof attributes === 'object' && !Array.isArray(attributes)
    ? Object.values(attributes as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  return values.length ? `${productName} — ${values.join(', ')}` : productName
}

/** Spec §4 step 2. Never blocks the new checkout: failures are logged and the sweep cleans up. */
async function releasePreviousOrder(orderId: string, payments: PaymentsPort): Promise<void> {
  const prev = await prisma.order.findUnique({
    where: { id: orderId }, select: { status: true, channel: true, stripeCheckoutSessionId: true },
  })
  if (!prev || prev.status !== 'pending' || prev.channel !== 'storefront' || !prev.stripeCheckoutSessionId) return
  try {
    // Expire FIRST: cancelling while the session is still open would release
    // stock the customer can then pay for in the other tab.
    if ((await payments.expireCheckoutSession(prev.stripeCheckoutSessionId)) === 'complete') return
    await cancelOrder(orderId, 'system')
  } catch (err) {
    if (err instanceof OrderError && err.code === 'invalid_transition') return
    console.error('[checkout] could not release previous order', orderId, scrubError(err))
  }
}

/**
 * Reports EVERY short line at once so the cart can mark them all. A read,
 * not a lock -- placeOrder's guarded UPDATE is the real check.
 */
async function preflight(lines: CheckoutRequest['lines']): Promise<Map<string, string>> {
  const variants = await prisma.variant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    include: { inventory: true, product: { select: { name: true, status: true } } },
  })
  const byId = new Map(variants.map((v) => [v.id, v]))
  const problems: LineProblem[] = []
  for (const line of lines) {
    const v = byId.get(line.variantId)
    if (!v || v.product.status !== 'published') {
      problems.push({ variantId: line.variantId, code: 'variant_not_found' })
      continue
    }
    const available = v.inventory ? storefrontSellable(v.inventory.onHand, v.inventory.reserved, v.inventory.walmartAllocation) : 0
    if (available < line.quantity) problems.push({ variantId: line.variantId, code: 'insufficient_stock', available })
  }
  if (problems.length > 0) throw stockError(problems)
  return new Map(variants.map((v) => [v.id, lineName(v.product.name, v.attributes)]))
}

export async function startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string; clientSecret: string }> {
  if (!deps.payments.configured || !deps.storefrontUrl) throw unavailable()
  const now = deps.now?.() ?? new Date()

  if (req.previousOrderId) await releasePreviousOrder(req.previousOrderId, deps.payments)
  const names = await preflight(req.lines)

  let order: OrderDto
  try {
    order = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: req.lines,
      marketingOptIn: req.marketingOptIn, referral: req.referral,
    }, deferredTaxAdapter)
  } catch (err) {
    if (err instanceof OrderError && (err.code === 'insufficient_stock' || err.code === 'variant_not_found')) {
      const available = err.details?.available
      throw stockError([{
        variantId: String(err.details?.variantId), code: err.code,
        ...(typeof available === 'number' ? { available } : {}),
      }])
    }
    throw err
  }

  // Outside the DB transaction (spec §4 step 4). If Stripe fails, release.
  let session: CheckoutSessionRef
  try {
    const settings = await getShopSettings()
    const shippingOptions = await deps.shipping.quote({ subtotalCents: order.subtotalCents, lines: req.lines })
    session = await deps.payments.createCheckoutSession({
      orderId: order.id,
      lines: order.lines.map((l) => ({ name: names.get(l.variantId) ?? l.sku, unitAmountCents: l.unitPriceCents, quantity: l.quantity })),
      shippingOptions,
      // Stripe's floor is 30 minutes after creation; +1 minute absorbs clock skew.
      expiresAt: new Date(now.getTime() + (settings.sessionMinutes + 1) * 60_000),
      returnUrl: `${deps.storefrontUrl}/order/complete?session_id={CHECKOUT_SESSION_ID}`,
    })
  } catch (err) {
    console.error('[checkout] Stripe session creation failed', order.id, scrubError(err))
    try {
      await cancelOrder(order.id, 'system')
    } catch (releaseErr) {
      console.error('[checkout] releasing after the Stripe failure also failed; the sweep will retry', order.id, scrubError(releaseErr))
    }
    throw unavailable()
  }

  await prisma.order.update({ where: { id: order.id }, data: { stripeCheckoutSessionId: session.sessionId } })
  return { orderId: order.id, clientSecret: session.clientSecret }
}

export interface CheckoutStatusDto {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

/** Spec §4 step 7: no address, no email. */
export async function getCheckoutStatus(sessionId: string): Promise<CheckoutStatusDto | null> {
  const o = await prisma.order.findUnique({
    where: { stripeCheckoutSessionId: sessionId },
    include: { lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } } },
  })
  if (!o) return null
  // A payment that landed after the sweep cancelled the order is money taken:
  // "confirming" is truer than "expired" while a human sorts out the refund.
  const status: CheckoutStatusDto['status'] =
    o.status === 'pending' || o.reviewReason === 'paid_after_cancel' ? 'pending'
      : o.status === 'cancelled' ? 'cancelled'
        : 'paid'
  return {
    status,
    orderNumber: orderNumber(o.number),
    lines: o.lines.map((l) => ({
      name: lineName(l.variant.product.name, l.variant.attributes), sku: l.sku, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
    })),
    totals: { subtotalCents: o.subtotalCents, shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents },
  }
}

/** What the cart needs to say "Free shipping on orders over $X" (plan decision 2). */
export async function getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }> {
  const s = await getShopSettings()
  return { flatRateCents: s.flatRateCents, freeShippingThresholdCents: s.freeThresholdCents }
}

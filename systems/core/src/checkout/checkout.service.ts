import { prisma } from '../prisma.js'
import {
  placeOrder, cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../orders/orders.service.js'
import { storefrontSellable } from '../inventory/allocation.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import type { ShippingPort } from '../ports/shipping/shipping.port.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, checkoutErrors, type CheckoutRequest, type QuoteRequest } from './checkout-input.js'
import { paymentBlocksRelease } from './payment-attempt.js'

export interface CheckoutDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  tax: TaxPort
  email: EmailPort
  now?: () => Date
}

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/**
 * Tax at placement: there is no address until the quote (spec §2 step 3).
 * The '_pending' suffix keeps the console showing tax as "pending" (plan decision 9).
 */
export const BEFORE_QUOTE_TAX: TaxPort = {
  async computeTax() {
    return { taxCents: 0, rateBps: 0, jurisdiction: 'quote_pending' }
  },
}

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

/**
 * Spec §2 step 1: cancel our own pending order (onlyIfPending). There is no
 * provider session to expire. Never blocks the new checkout: failures are
 * logged, and the sweep cleans up.
 */
async function releasePreviousOrder(orderId: string, now: Date): Promise<void> {
  try {
    const cancelled = await prisma.$transaction(async (tx) => {
      const prev = await lockOrderRow(tx, orderId)
      if (!prev || prev.channel !== 'storefront' || prev.status !== 'pending') return null
      if (paymentBlocksRelease(prev, now)) return null // final review C1: a recorded payment blocks it too
      return cancelOrderTx(tx, orderId, 'system', { onlyIfPending: true })
    })
    if (cancelled) {
      await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `checkout.previous order:${orderId}`)
    }
  } catch (err) {
    console.error('[checkout] could not release previous order', orderId, scrubError(err))
  }
}

/**
 * Reports EVERY short line at once so the cart can mark them all. A read,
 * not a lock -- placeOrder's guarded UPDATE is the real check.
 */
async function preflight(lines: CheckoutRequest['lines']): Promise<void> {
  const variants = await prisma.variant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    include: { inventory: true, product: { select: { status: true } } },
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
}

/** Spec §2 step 1: live re-pricing, reservation and a pending order. */
export async function startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string }> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const now = deps.now?.() ?? new Date()
  if (req.previousOrderId) await releasePreviousOrder(req.previousOrderId, now)
  await preflight(req.lines)
  try {
    const order = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: req.lines,
      marketingOptIn: req.marketingOptIn, referral: req.referral,
    }, BEFORE_QUOTE_TAX)
    return { orderId: order.id }
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
}

export interface QuoteDto { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }

/**
 * Spec §2 step 3. The ports are asked first, outside the transaction; the
 * write happens under the order's row lock and re-checks `pending` and the
 * in-flight attempt. Tax is on the goods only (Q8), net of each line's discount.
 *
 * Ruling Q-P1: while a payment attempt is in flight the quote is refused with
 * 409 payment_pending -- re-pricing under a charge that may be landing would
 * make the paid total disagree with the order.
 *
 * Ruling T3-R1: an order that already has a Square payment id (a payment
 * exists, final or not) is never re-quoted either, whatever its attempt age.
 */
export async function quoteCheckout(orderId: string, req: QuoteRequest, deps: CheckoutDeps): Promise<QuoteDto> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order || order.channel !== 'storefront') throw checkoutErrors.notFound()
  if (order.status !== 'pending') throw checkoutErrors.expired()
  if (paymentBlocksRelease(order, deps.now?.() ?? new Date())) throw checkoutErrors.paymentPending()

  const [shipping] = await deps.shipping.quote({
    subtotalCents: order.subtotalCents, lines: order.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  })
  if (!shipping) throw checkoutErrors.unavailable()
  const tax = await deps.tax.computeTax({
    shipToState: req.address.state,
    lineItems: order.lines.map((l) => ({ amountCents: l.lineSubtotalCents - l.discountCents })),
  })

  return prisma.$transaction(async (tx) => {
    const locked = await lockOrderRow(tx, orderId)
    if (!locked || locked.status !== 'pending') throw checkoutErrors.expired()
    if (paymentBlocksRelease(locked, deps.now?.() ?? new Date())) throw checkoutErrors.paymentPending()
    const next = await tx.order.update({
      where: { id: orderId },
      data: {
        email: req.email,
        shipName: req.name,
        shipLine1: req.address.line1,
        shipLine2: req.address.line2,
        shipCity: req.address.city,
        shipToState: req.address.state,
        shipPostalCode: req.address.postalCode,
        shippingCents: shipping.amountCents,
        taxCents: tax.taxCents,
        taxRateBps: tax.rateBps,
        taxJurisdiction: tax.jurisdiction,
        totalCents: locked.subtotalCents - locked.discountCents + shipping.amountCents + tax.taxCents,
        quoteVersion: { increment: 1 },
      },
    })
    return {
      quoteVersion: next.quoteVersion, subtotalCents: next.subtotalCents, shippingCents: next.shippingCents,
      taxCents: next.taxCents, totalCents: next.totalCents,
    }
  })
}

export interface CheckoutStatusDto {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

/** Spec §2 step 6: by order id; no address, no email. */
export async function getCheckoutStatus(orderId: string): Promise<CheckoutStatusDto | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } } },
  })
  if (!o || o.channel !== 'storefront') return null
  // Money taken after a cancel is "confirming", not "expired", while a human sorts out the refund.
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

/** What the cart needs to say "Free shipping on orders over $X". */
export async function getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }> {
  const s = await getShopSettings()
  return { flatRateCents: s.flatRateCents, freeShippingThresholdCents: s.freeThresholdCents }
}

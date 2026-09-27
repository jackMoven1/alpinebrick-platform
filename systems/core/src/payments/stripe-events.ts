import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import {
  lockOrderRow, markOrderPaidTx, cancelOrderTx, refundOrderTx, enqueueInventoryPushesAfterCommit, orderNumber,
} from '../orders/orders.service.js'
import { upsertCustomerFromCheckout, normalizeEmail } from '../customers/customers.service.js'
import { resolveReferral } from '../referrals/referrals.service.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'

/** Spec §4: AK, HI, and territory/military codes. */
export const OUTSIDE_SHIPPING_AREA: ReadonlySet<string> = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'])

export type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.expired', 'charge.refunded', 'charge.dispute.created'])

/** How long an unmatched refund/dispute is answered 503 (retry) before it is logged and acknowledged. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

class DuplicateEvent extends Error {}
/** Thrown when the event cannot be applied YET; the route answers 503 and Stripe redelivers. */
class RetryLater extends Error {}

type Tx = Prisma.TransactionClient
/** Work to run after the transaction commits (inventory pushes, email). */
type FollowUp = () => Promise<void>

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : v?.id ?? null

async function onCompleted(tx: Tx, session: Stripe.Checkout.Session, deps: { email: EmailPort }): Promise<FollowUp | null> {
  if (session.payment_status !== 'paid') {
    console.warn('[stripe] completed session not paid; ignoring', session.id, session.payment_status)
    return null
  }
  const orderId = session.metadata?.orderId ?? session.client_reference_id
  const order = orderId ? await lockOrderRow(tx, orderId) : null
  if (!order) {
    console.error('[stripe] completed session for an unknown order', session.id, orderId)
    return null
  }

  const ship = session.collected_information?.shipping_details ?? null
  const addr = ship?.address
  const rawEmail = session.customer_details?.email
  const state = (addr?.state ?? '').trim().toUpperCase()
  const details = {
    email: rawEmail ? normalizeEmail(rawEmail) : order.email,
    shipName: ship?.name ?? session.customer_details?.name ?? null,
    shipLine1: addr?.line1 ?? null,
    shipLine2: addr?.line2 ?? null,
    shipCity: addr?.city ?? null,
    shipPostalCode: addr?.postal_code ?? null,
    shipToState: state,
    stripePaymentIntentId: idOf(session.payment_intent as string | { id: string } | null),
    paidAt: new Date(),
  }

  if (order.status === 'cancelled') {
    // The sweep or an admin beat the webhook. Money was taken: record who
    // paid so a human can refund in Stripe (spec §5). Every paid order gets a
    // Customer (D3, ruling P16), this one included.
    const customer = await upsertCustomerFromCheckout({ email: details.email, name: details.shipName, consent: order.marketingOptIn }, tx)
    await tx.order.update({
      where: { id: order.id }, data: { ...details, customerId: customer.id, reviewReason: 'paid_after_cancel' },
    })
    await recordAudit({ actorId: 'system', action: 'order.paid_after_cancel', target: `order:${order.id}`, after: { stripePaymentIntentId: details.stripePaymentIntentId } }, tx)
    console.error(`[stripe] order ${order.id} was PAID AFTER IT WAS CANCELLED -- refund it in Stripe`)
    return null
  }
  if (order.status !== 'pending') {
    console.warn('[stripe] completed session for a non-pending order; ignoring', order.id, order.status)
    return null
  }

  // total_details.amount_tax is ALL tax, including tax on shipping, and
  // amount_shipping is pre-tax -- so the identity is subtotal + shipping + tax
  // (- discount). shipping_cost.amount_total already includes shipping tax and
  // would double-count it (plan header).
  const taxCents = session.total_details?.amount_tax ?? 0
  const shippingCents = session.total_details?.amount_shipping ?? 0
  const discountCents = session.total_details?.amount_discount ?? 0
  const totalCents = session.amount_total ?? 0
  const expected = order.subtotalCents + shippingCents + taxCents - discountCents
  const mismatch = totalCents !== expected
  const outside = OUTSIDE_SHIPPING_AREA.has(state) || (addr?.country != null && addr.country !== 'US')
  if (mismatch) console.error(`[stripe] order ${order.id} amount mismatch: Stripe ${totalCents}, expected ${expected}`)
  if (outside) console.error(`[stripe] order ${order.id} ships outside the contiguous US (${state || addr?.country}) -- refund in Stripe`)
  const base = order.subtotalCents + shippingCents

  const paid = await markOrderPaidTx(tx, order.id, 'system', {
    ...details,
    taxCents, shippingCents, totalCents,
    taxJurisdiction: 'stripe_tax',
    // Effective rate over the taxable base Stripe saw (goods + shipping).
    taxRateBps: base > 0 ? Math.round((taxCents * 10000) / base) : 0,
    // One column, two conditions: the money problem wins (ruling P17); both
    // were logged above, and the address stays on the order.
    reviewReason: mismatch ? 'amount_mismatch' : outside ? 'outside_shipping_area' : null,
  })

  const customer = await upsertCustomerFromCheckout({ email: details.email, name: details.shipName, consent: order.marketingOptIn }, tx)
  const referral = order.referralCode ? await resolveReferral(order.referralCode, tx) : null
  await tx.order.update({
    where: { id: order.id },
    data: {
      customerId: customer.id,
      ...(order.referralCode
        ? referral
          ? { affiliatePartnerId: referral.partnerId, commissionRateBps: referral.commissionRateBps }
          : { referralUnmatched: true }
        : {}),
    },
  })

  return async () => {
    try {
      await deps.email.orderPaid({ orderId: paid.id, orderNumber: orderNumber(paid.number), email: details.email })
    } catch (err) {
      console.error('[stripe] orderPaid email failed', paid.id, scrubError(err))
    }
  }
}

async function onExpired(tx: Tx, session: Stripe.Checkout.Session): Promise<FollowUp | null> {
  const orderId = session.metadata?.orderId ?? session.client_reference_id
  const order = orderId ? await lockOrderRow(tx, orderId) : null
  if (!order || order.status !== 'pending') return null
  const cancelled = await cancelOrderTx(tx, order.id, 'system')
  return () => enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `checkout.expired order:${order.id}`)
}

async function orderIdByPaymentIntent(tx: Tx, pi: string | null): Promise<string> {
  const order = pi ? await tx.order.findUnique({ where: { stripePaymentIntentId: pi }, select: { id: true } }) : null
  // Not found yet: the completed event may not have landed. 503 -> Stripe
  // retries (plan decision 6) -- but only while the event is young; see
  // RETRY_WINDOW_MS in handleStripeEvent (ruling P15).
  if (!order) throw new RetryLater(`no order for payment intent ${pi}`)
  return order.id
}

async function onRefunded(tx: Tx, charge: Stripe.Charge): Promise<FollowUp | null> {
  const orderId = await orderIdByPaymentIntent(tx, idOf(charge.payment_intent as string | { id: string } | null))
  const full = charge.refunded === true || charge.amount_refunded >= charge.amount
  const { releasedVariantIds } = await refundOrderTx(tx, orderId, { refundedCents: charge.amount_refunded, full }, 'system')
  return releasedVariantIds.length
    ? () => enqueueInventoryPushesAfterCommit(releasedVariantIds, `charge.refunded order:${orderId}`)
    : null
}

async function onDispute(tx: Tx, dispute: Stripe.Dispute): Promise<FollowUp | null> {
  const orderId = await orderIdByPaymentIntent(tx, idOf(dispute.payment_intent as string | { id: string } | null))
  await tx.order.update({ where: { id: orderId }, data: { reviewReason: 'disputed' } })
  await recordAudit({ actorId: 'system', action: 'order.disputed', target: `order:${orderId}`, after: { dispute: dispute.id } }, tx)
  console.error(`[stripe] order ${orderId} has a DISPUTE (${dispute.id}) -- respond in the Stripe dashboard`)
  return null
}

/**
 * Applies one verified event. The StripeEvent insert and the event's effects
 * share one transaction (spec §5): a crash commits neither, and a concurrent
 * or repeated delivery blocks on the primary key, then fails with P2002
 * -> 'duplicate'.
 */
export async function handleStripeEvent(event: Stripe.Event, deps: { email: EmailPort }): Promise<EventOutcome> {
  if (!HANDLED.has(event.type)) return 'ignored'
  let followUp: FollowUp | null = null
  try {
    followUp = await prisma.$transaction(async (tx) => {
      try {
        await tx.stripeEvent.create({ data: { id: event.id, type: event.type } })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateEvent()
        throw err
      }
      const object = event.data.object as unknown
      switch (event.type) {
        case 'checkout.session.completed': return onCompleted(tx, object as Stripe.Checkout.Session, deps)
        case 'checkout.session.expired': return onExpired(tx, object as Stripe.Checkout.Session)
        case 'charge.refunded': return onRefunded(tx, object as Stripe.Charge)
        case 'charge.dispute.created': return onDispute(tx, object as Stripe.Dispute)
        default: return null
      }
    })
  } catch (err) {
    if (err instanceof DuplicateEvent) return 'duplicate'
    if (err instanceof RetryLater) {
      // Ruling P15: an out-of-order refund/dispute lands within minutes of its
      // checkout. One still unmatched after a day is almost certainly a charge
      // unrelated to the storefront; retrying it for Stripe's full 3 days would
      // pile up failed deliveries and risk Stripe disabling the endpoint. Log it
      // loudly and acknowledge it, recording nothing.
      if (Date.now() - event.created * 1000 >= RETRY_WINDOW_MS) {
        console.error(`[stripe] ${event.id} (${event.type}) matched no order after 24h; acknowledging without applying -- check it in Stripe: ${err.message}`)
        return 'ignored'
      }
      console.warn('[stripe] deferring event', event.id, event.type, err.message)
      return 'retry'
    }
    throw err
  }
  if (followUp) await followUp()
  return 'processed'
}

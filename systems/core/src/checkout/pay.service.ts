import { prisma } from '../prisma.js'
import { lockOrderRow } from '../orders/orders.service.js'
import {
  PaymentAttemptConflictError, PaymentOutcomeUnknownError, type ChargeResult, type ShipToAddress,
} from '../ports/payments/payments.port.js'
import { applyCompletedPayment, releaseFailedPayment } from '../payments/complete-payment.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, checkoutErrors, type PayRequest } from './checkout-input.js'
import { getCheckoutStatus, type CheckoutDeps, type CheckoutStatusDto } from './checkout.service.js'

/** Plan decision 6: the number of declines after which an order stops taking attempts. */
export const MAX_PAYMENT_ATTEMPTS = 10

export type PayResult = (Omit<CheckoutStatusDto, 'status'> & { status: 'paid' }) | { status: 'processing' }

type Attempt =
  | { replay: true }
  | { replay: false; key: string; attemptCount: number; amountCents: number; email: string; address: ShipToAddress }

/** What the shopper should see for this order now, read from the database. */
async function currentResult(orderId: string): Promise<PayResult> {
  const s = await getCheckoutStatus(orderId)
  return s?.status === 'paid' ? { ...s, status: 'paid' } : { status: 'processing' }
}

/**
 * Square gave a definite answer and created no payment (declined, or a
 * non-decline 4xx). Ruling T2-R2: move to the next idempotency key and clear
 * the in-flight stamp. Guarded on the count this attempt used, so two racing
 * answers move it once.
 */
async function closeAttempt(orderId: string, attemptCount: number): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: 'pending', paymentAttemptCount: attemptCount },
    data: { paymentAttemptCount: { increment: 1 }, paymentAttemptAt: null },
  })
}

/**
 * Spec §2 step 5. The lock-check-stamp commits BEFORE the charge, so a sweep
 * running during the charge sees paymentAttemptAt and skips the order. A
 * sweep that won the lock first leaves this answering order_expired before
 * any charge (the race rule).
 */
export async function payForOrder(orderId: string, req: PayRequest, deps: CheckoutDeps): Promise<PayResult> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const now = deps.now?.() ?? new Date()

  const attempt = await prisma.$transaction(async (tx): Promise<Attempt> => {
    const o = await lockOrderRow(tx, orderId)
    if (!o || o.channel !== 'storefront') throw checkoutErrors.notFound()
    // A lost 200, retried (plan decision 4): answer from the database. Any
    // quoteVersion -- a stale tab must not see order_expired for money that
    // was taken (ruling T4-R5). Fulfilled and refunded orders were paid too.
    if (o.status === 'paid' || o.status === 'fulfilled' || o.status === 'refunded') return { replay: true }
    if (o.status !== 'pending') throw checkoutErrors.expired()
    if (o.quoteVersion === 0 || o.quoteVersion !== req.quoteVersion || !o.shipLine1) throw checkoutErrors.quoteChanged()
    if (o.paymentAttemptCount >= MAX_PAYMENT_ATTEMPTS) throw checkoutErrors.tooManyAttempts()
    await tx.order.update({ where: { id: orderId }, data: { paymentAttemptAt: now } })
    return {
      replay: false,
      key: `${o.id}:${o.quoteVersion}:${o.paymentAttemptCount}`,
      attemptCount: o.paymentAttemptCount,
      amountCents: o.totalCents,
      email: o.email,
      address: {
        name: o.shipName ?? '', line1: o.shipLine1, line2: o.shipLine2, city: o.shipCity ?? '',
        state: o.shipToState, postalCode: o.shipPostalCode ?? '',
      },
    }
  })
  if (attempt.replay) return currentResult(orderId)

  let result: ChargeResult
  try {
    result = await deps.payments.charge({
      sourceToken: req.sourceToken, amountCents: attempt.amountCents, idempotencyKey: attempt.key,
      referenceId: orderId, buyerEmail: attempt.email, shippingAddress: attempt.address,
    })
  } catch (err) {
    if (err instanceof PaymentAttemptConflictError) throw checkoutErrors.paymentPending()
    if (err instanceof PaymentOutcomeUnknownError) {
      // The count, and so the key, is left alone, and so is the stamp: a
      // retry with the same token replays Square's answer (plan decision 3).
      console.error('[checkout] payment outcome unknown', orderId, scrubError(err))
      throw checkoutErrors.unavailable()
    }
    // Anything else is our bug (the port promises the classes above). The
    // stamp stays -- the safe side -- and the sweep releases the order.
    throw err
  }

  if (result.outcome === 'declined') {
    // A replayed processing payment that ended FAILED/CANCELED (ruling T4-R4).
    if (result.paymentId) await releaseFailedPayment(prisma, result.paymentId)
    await closeAttempt(orderId, attempt.attemptCount)
    throw new CheckoutError('payment_declined', result.message, 402)
  }

  if (result.outcome === 'failed') {
    // Ruling Q-P10: no payment was created. `reason` is for logs only.
    await closeAttempt(orderId, attempt.attemptCount)
    console.error('[checkout] payment request refused', orderId, result.reason)
    throw checkoutErrors.unavailable()
  }

  if (result.outcome === 'processing') {
    // The stamp stays (ruling T3-R1): a live payment's total must not change.
    await prisma.order.updateMany({ where: { id: orderId, squarePaymentId: null }, data: { squarePaymentId: result.paymentId } })
    return { status: 'processing' }
  }

  const completed = { paymentId: result.paymentId, amountCents: result.amountCents }
  let followUp
  try {
    ({ followUp } = await prisma.$transaction((tx) => applyCompletedPayment(tx, orderId, completed, deps)))
  } catch (err) {
    // Money was taken and our write failed (ruling T4-R4). Record the payment
    // id if nothing else holds the slot, so the sweep (Q-P7) keeps the stock
    // held; the webhook or a replay then completes the order.
    console.error(`[checkout] order ${orderId}: payment ${completed.paymentId} COMPLETED but marking the order paid failed`, scrubError(err))
    await prisma.order.updateMany({
      where: { id: orderId, status: 'pending', squarePaymentId: null },
      data: { squarePaymentId: completed.paymentId },
    }).catch((e) => console.error(`[checkout] order ${orderId}: could not record payment ${completed.paymentId}`, scrubError(e)))
    throw err
  }
  if (followUp) await followUp()
  return currentResult(orderId)
}

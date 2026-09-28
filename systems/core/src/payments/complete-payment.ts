import type { OrderReviewReason, Prisma } from '@prisma/client'
import { recordAudit } from '../audit.js'
import { lockOrderRow, markOrderPaidTx, orderNumber, type OrderWithLines } from '../orders/orders.service.js'
import { upsertCustomerFromCheckout } from '../customers/customers.service.js'
import { resolveReferral } from '../referrals/referrals.service.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'

/** Work to run after the transaction commits (email). */
export type FollowUp = () => Promise<void>
export interface CompletedPayment { paymentId: string; amountCents: number }
export type CompletionOutcome = 'paid' | 'already_paid' | 'paid_after_cancel' | 'not_applied'

/**
 * An order has one review-reason slot. A duplicate payment takes it from a
 * milder reason, and leaves a more severe one in place (ruling Q-P1): money
 * taken after a cancel, or a dispute, already needs a human on this order.
 */
const MORE_SEVERE_THAN_DUPLICATE: ReadonlySet<OrderReviewReason> = new Set(['paid_after_cancel', 'disputed'])

/**
 * A second COMPLETED payment for an order that already carries a different
 * one: money taken twice. Not applied; flagged, audited and logged with both
 * payment ids so the duplicate can be refunded (ruling Q-P1).
 */
async function recordDuplicate(tx: Prisma.TransactionClient, order: OrderWithLines, payment: CompletedPayment): Promise<void> {
  const keep = order.reviewReason !== null && MORE_SEVERE_THAN_DUPLICATE.has(order.reviewReason)
  if (!keep) await tx.order.update({ where: { id: order.id }, data: { reviewReason: 'duplicate_payment' } })
  await recordAudit({
    actorId: 'system', action: 'order.duplicate_payment', target: `order:${order.id}`,
    after: { squarePaymentId: payment.paymentId, existingSquarePaymentId: order.squarePaymentId },
  }, tx)
  console.error(
    `[payments] order ${order.id} is ${order.status} with payment ${order.squarePaymentId}, but payment ${payment.paymentId} also completed for it`
    + ` -- refund the duplicate in the payment dashboard${keep ? ` (review reason kept: ${order.reviewReason})` : ''}`,
  )
}

/**
 * A COMPLETED Square payment, applied to its order inside the caller's
 * transaction. The pay route (spec §2 step 5.4) and payment.updated (§3)
 * share this, so a crash between the charge and the write is repaired by
 * the webhook with the same code. It is safe to repeat and to receive in any order.
 */
export async function applyCompletedPayment(
  tx: Prisma.TransactionClient,
  orderId: string,
  payment: CompletedPayment,
  deps: { email: EmailPort },
): Promise<{ outcome: CompletionOutcome; followUp: FollowUp | null }> {
  const order = await lockOrderRow(tx, orderId)
  if (!order || order.channel !== 'storefront') return { outcome: 'not_applied', followUp: null }
  const target = `order:${order.id}`

  if (order.status !== 'pending' && order.squarePaymentId === payment.paymentId) {
    return { outcome: 'already_paid', followUp: null }
  }

  // Past pending under a DIFFERENT payment (paid, fulfilled, refunded, or
  // cancelled with money already recorded against it): a second charge.
  if (order.status !== 'pending' && order.squarePaymentId !== null) {
    await recordDuplicate(tx, order, payment)
    return { outcome: 'not_applied', followUp: null }
  }

  if (order.status === 'cancelled') {
    // Money taken for an order already cancelled. Our own code cannot get
    // here (race rule, §2); it is recorded for a human to refund.
    const customer = await upsertCustomerFromCheckout({ email: order.email, name: order.shipName, consent: order.marketingOptIn }, tx)
    await tx.order.update({
      where: { id: order.id },
      data: { squarePaymentId: payment.paymentId, paidAt: new Date(), customerId: customer.id, reviewReason: 'paid_after_cancel' },
    })
    await recordAudit({ actorId: 'system', action: 'order.paid_after_cancel', target, after: { squarePaymentId: payment.paymentId } }, tx)
    console.error(`[payments] order ${order.id} was PAID AFTER IT WAS CANCELLED -- refund it in the payment dashboard`)
    return { outcome: 'paid_after_cancel', followUp: null }
  }

  if (order.status !== 'pending') {
    // Past pending with no payment id on record: not a state our code writes.
    await recordDuplicate(tx, order, payment)
    return { outcome: 'not_applied', followUp: null }
  }

  if (order.squarePaymentId !== null && order.squarePaymentId !== payment.paymentId) {
    // A processing payment was recorded, and a different one completed.
    console.error(`[payments] order ${order.id} had payment ${order.squarePaymentId} in progress, but payment ${payment.paymentId} completed -- check both in the payment dashboard`)
  }

  const mismatch = payment.amountCents !== order.totalCents
  if (mismatch) console.error(`[payments] order ${order.id} amount mismatch: charged ${payment.amountCents}, order total ${order.totalCents}`)
  const paid = await markOrderPaidTx(tx, order.id, 'system', {
    squarePaymentId: payment.paymentId,
    paidAt: new Date(),
    reviewReason: mismatch ? 'amount_mismatch' : null,
  })

  const customer = await upsertCustomerFromCheckout({ email: order.email, name: order.shipName, consent: order.marketingOptIn }, tx)
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

  return {
    outcome: 'paid',
    followUp: async () => {
      try {
        await deps.email.orderPaid({ orderId: paid.id, orderNumber: orderNumber(paid.number), email: order.email })
      } catch (err) {
        console.error('[payments] orderPaid email failed', paid.id, scrubError(err))
      }
    },
  }
}

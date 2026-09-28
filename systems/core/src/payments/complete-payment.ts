import type { OrderReviewReason, Prisma } from '@prisma/client'
import { recordAudit } from '../audit.js'
import { lockOrderRow, markOrderPaidTx, orderNumber, type OrderWithLines } from '../orders/orders.service.js'
import { upsertCustomerFromCheckout } from '../customers/customers.service.js'
import { resolveReferral } from '../referrals/referrals.service.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'

/** Work to run after the transaction commits (email). */
export type FollowUp = () => Promise<void>
/**
 * `amountCents` is null when Square's amount could not be read as USD cents
 * (no amount_money, or another currency): the completion still applies, but
 * no amount_mismatch is inferred from a figure we do not have (final review minor 3).
 */
export interface CompletedPayment { paymentId: string; amountCents: number | null }
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
 *
 * Idempotent per duplicate payment id (final review I1): Square redelivers
 * payment.updated under new event ids, and once an operator has refunded the
 * duplicate and cleared the flag -- perhaps after the order shipped -- a
 * redelivery must not audit it again or put the flag back.
 */
async function recordDuplicate(tx: Prisma.TransactionClient, order: OrderWithLines, payment: CompletedPayment): Promise<void> {
  const seen = await tx.auditLog.findFirst({
    where: { action: 'order.duplicate_payment', target: `order:${order.id}`, after: { path: ['squarePaymentId'], equals: payment.paymentId } },
    select: { id: true },
  })
  if (seen) return
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
    if (order.status === 'cancelled' && order.reviewReason === null) {
      // Defence in depth (final review C1): a pending order carrying this
      // payment was cancelled and the payment has now COMPLETED. No path of
      // ours should cancel such an order (paymentBlocksRelease); if one ever
      // does, the money must not go unnoticed. An order already flagged
      // (paid_after_cancel, disputed, ...) is left as it is.
      // Same record as the cancelled-order path below.
      const customer = await upsertCustomerFromCheckout({ email: order.email, name: order.shipName, consent: order.marketingOptIn }, tx)
      await tx.order.update({
        where: { id: order.id },
        data: { paidAt: order.paidAt ?? new Date(), customerId: customer.id, reviewReason: 'paid_after_cancel' },
      })
      await recordAudit({ actorId: 'system', action: 'order.paid_after_cancel', target, after: { squarePaymentId: payment.paymentId } }, tx)
      console.error(`[payments] order ${order.id} was PAID AFTER IT WAS CANCELLED (payment ${payment.paymentId}) -- refund it in the payment dashboard`)
      return { outcome: 'paid_after_cancel', followUp: null }
    }
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

  const mismatch = payment.amountCents !== null && payment.amountCents !== order.totalCents
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

/**
 * A payment we recorded while it was not final (pay answered `processing`)
 * has FAILED or been CANCELED: no money was taken. Ruling T4-R4 -- the order
 * drops the payment id and closes the attempt (as a decline does, ruling
 * T2-R2), so it can be re-quoted and paid under a new idempotency key.
 * Matches only on the recorded id, so a stale failure for some other payment
 * never clears a live attempt. Safe to repeat.
 */
export async function releaseFailedPayment(db: Pick<Prisma.TransactionClient, 'order'>, paymentId: string): Promise<boolean> {
  const { count } = await db.order.updateMany({
    where: { squarePaymentId: paymentId, status: 'pending' },
    data: { squarePaymentId: null, paymentAttemptAt: null, paymentAttemptCount: { increment: 1 } },
  })
  return count > 0
}

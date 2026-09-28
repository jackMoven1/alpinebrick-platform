import { prisma } from '../prisma.js'
import { cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit } from '../orders/orders.service.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'
import { PAYMENT_ATTEMPT_GRACE_MS, paymentBlocksRelease } from './payment-attempt.js'

export const SWEEP_INTERVAL_MS = 5 * 60_000
const BATCH = 100

/**
 * Spec §2 step 7. Cancels (onlyIfPending) pending STOREFRONT orders older
 * than checkout.session_minutes whose paymentAttemptAt is null or older than
 * 10 minutes, AND that carry no squarePaymentId. It makes no provider call:
 * an unpaid order is simply our pending row. Ruling Q-P7: an order with a
 * squarePaymentId is a known payment -- final or not -- and is never
 * cancelled by the sweep, no matter how stale paymentAttemptAt is. Both the
 * attempt check and the squarePaymentId check are repeated under the row
 * lock, because pay may stamp the order (and later record the payment id)
 * between the read below and the lock (race rule).
 */
export async function sweepAbandonedCheckouts(now = new Date()): Promise<{ cancelled: string[]; skipped: string[] }> {
  const { sessionMinutes } = await getShopSettings()
  const createdBefore = new Date(now.getTime() - sessionMinutes * 60_000)
  const attemptBefore = new Date(now.getTime() - PAYMENT_ATTEMPT_GRACE_MS)
  const stale = await prisma.order.findMany({
    where: {
      status: 'pending', channel: 'storefront', createdAt: { lt: createdBefore }, squarePaymentId: null,
      OR: [{ paymentAttemptAt: null }, { paymentAttemptAt: { lt: attemptBefore } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  const cancelled: string[] = []
  const skipped: string[] = []
  for (const { id } of stale) {
    try {
      const released = await prisma.$transaction(async (tx) => {
        const o = await lockOrderRow(tx, id)
        if (!o || o.status !== 'pending' || paymentBlocksRelease(o, now)) return null
        return cancelOrderTx(tx, id, 'system', { onlyIfPending: true })
      })
      if (!released) {
        skipped.push(id)
        continue
      }
      cancelled.push(id)
      await enqueueInventoryPushesAfterCommit(released.lines.map((l) => l.variantId), `checkout.sweep order:${id}`)
    } catch (err) {
      console.error('[checkout-sweep] failed for order', id, scrubError(err))
      skipped.push(id)
    }
  }
  return { cancelled, skipped }
}

/** Runs in the web process; core-worker is Walmart-only and unprovisioned. */
export function startCheckoutSweep(payments: Pick<PaymentsPort, 'configured'>, intervalMs = SWEEP_INTERVAL_MS): () => void {
  if (!payments.configured) {
    console.log('checkout sweep: payments are not configured -- not started')
    return () => {}
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepAbandonedCheckouts()
      .then((r) => { if (r.cancelled.length) console.log(`checkout sweep: cancelled ${r.cancelled.length} abandoned order(s)`) })
      .catch((err) => console.error('[checkout-sweep] run failed', scrubError(err)))
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

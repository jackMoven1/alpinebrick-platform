import { prisma } from '../prisma.js'
import { cancelOrder, OrderError } from '../orders/orders.service.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'

export const SWEEP_INTERVAL_MS = 5 * 60_000
export const SWEEP_GRACE_MINUTES = 10
const BATCH = 100

/**
 * Backstop for a missed checkout.session.expired webhook (spec §5). Cancels
 * pending STOREFRONT orders older than session lifetime + grace when Stripe
 * reports the session expired, or complete-but-unpaid. An order that never
 * got a session (the process died between placeOrder and saving the id) is
 * cancelled too (plan decision 5). A paid session with a pending order means
 * the webhook was missed: it is logged, never cancelled -- money was taken.
 */
export async function sweepAbandonedCheckouts(
  payments: PaymentsPort,
  now = new Date(),
): Promise<{ cancelled: string[]; skipped: string[] }> {
  const { sessionMinutes } = await getShopSettings()
  const cutoff = new Date(now.getTime() - (sessionMinutes + SWEEP_GRACE_MINUTES) * 60_000)
  const stale = await prisma.order.findMany({
    where: { status: 'pending', channel: 'storefront', createdAt: { lt: cutoff } },
    select: { id: true, stripeCheckoutSessionId: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  const cancelled: string[] = []
  const skipped: string[] = []
  for (const order of stale) {
    try {
      if (order.stripeCheckoutSessionId) {
        const s = await payments.retrieveCheckoutSession(order.stripeCheckoutSessionId)
        const abandoned = s.status === 'expired' || (s.status === 'complete' && s.paymentStatus !== 'paid')
        if (!abandoned) {
          if (s.status === 'complete') {
            console.error(`[checkout-sweep] order ${order.id} is PAID in Stripe but still pending here -- the completed webhook was missed; resend it from the Stripe dashboard`)
          }
          skipped.push(order.id)
          continue
        }
      }
      await cancelOrder(order.id, 'system')
      cancelled.push(order.id)
    } catch (err) {
      if (!(err instanceof OrderError && err.code === 'invalid_transition')) {
        console.error('[checkout-sweep] failed for order', order.id, scrubError(err))
      }
      skipped.push(order.id)
    }
  }
  return { cancelled, skipped }
}

/** Runs in the web process (spec §5); core-worker is Walmart-only and unprovisioned. */
export function startCheckoutSweep(payments: PaymentsPort, intervalMs = SWEEP_INTERVAL_MS): () => void {
  if (!payments.configured) {
    console.log('checkout sweep: Stripe is not configured -- not started')
    return () => {}
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepAbandonedCheckouts(payments)
      .then((r) => { if (r.cancelled.length) console.log(`checkout sweep: cancelled ${r.cancelled.length} abandoned order(s)`) })
      .catch((err) => console.error('[checkout-sweep] run failed', scrubError(err)))
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

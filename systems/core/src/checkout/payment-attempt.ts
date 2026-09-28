/**
 * Spec §2 step 7 and the race rule: POST /checkout/:id/pay stamps
 * paymentAttemptAt before it charges. For this long afterwards, nothing of
 * ours cancels the order -- not the sweep, not a previousOrderId release,
 * not the admin Cancel (plan decision 7) -- and the quote route will not
 * re-price it (ruling Q-P1), because a charge may be landing.
 *
 * A definite answer from Square (declined, failed) clears paymentAttemptAt
 * (ruling T2-R2), so a stamp inside the window means the outcome is unknown.
 * This is the ONE place that rule lives (ruling Q-P6): the sweep, the admin
 * Cancel, the previousOrderId release and the quote all ask it.
 */
export const PAYMENT_ATTEMPT_GRACE_MS = 10 * 60_000

export function attemptInFlight(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < PAYMENT_ATTEMPT_GRACE_MS
}

/** `attemptInFlight` for anything carrying an order's `paymentAttemptAt`. */
export function isPaymentInFlight(order: { paymentAttemptAt: Date | null }, now: Date): boolean {
  return attemptInFlight(order.paymentAttemptAt, now)
}

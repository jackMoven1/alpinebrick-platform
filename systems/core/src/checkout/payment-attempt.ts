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
 * Cancel, the previousOrderId release and the quote all ask it, through
 * paymentBlocksRelease below.
 */
export const PAYMENT_ATTEMPT_GRACE_MS = 10 * 60_000

export function attemptInFlight(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < PAYMENT_ATTEMPT_GRACE_MS
}

/** `attemptInFlight` for anything carrying an order's `paymentAttemptAt`. */
export function isPaymentInFlight(order: { paymentAttemptAt: Date | null }, now: Date): boolean {
  return attemptInFlight(order.paymentAttemptAt, now)
}

/**
 * Final review C1 (ruling F-R1): may our own code release this pending
 * order's stock? Not while a Square payment id is recorded (a payment exists,
 * final or not -- ruling Q-P7), however stale the attempt stamp, and not while
 * an attempt is in flight. The sweep, the admin Cancel, the previousOrderId
 * release and the quote all ask THIS, so the four can never disagree again.
 */
export function paymentBlocksRelease(
  order: { squarePaymentId: string | null; paymentAttemptAt: Date | null },
  now: Date,
): boolean {
  return !!order.squarePaymentId || isPaymentInFlight(order, now)
}

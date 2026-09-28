import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { lockOrderRow, refundOrderTx, enqueueInventoryPushesAfterCommit, OrderError } from '../orders/orders.service.js'
import type { PaymentSummary, PaymentsPort, RefundSummary } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { applyCompletedPayment, releaseFailedPayment, type FollowUp } from './complete-payment.js'
import { scrubError } from '../auth/scrub.js'

/** Spec §3, and the five event types the runbook subscribes to. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'payment.updated', 'refund.created', 'refund.updated', 'dispute.created', 'dispute.state.updated',
])
/** Square retries a failed delivery for 24 hours; after that we log and acknowledge (P15). */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'

// Webhook payloads are raw snake_case JSON (plan header), not the SDK's camelCase types.
interface SqPayment { id?: string; status?: string; amount_money?: { amount?: number; currency?: string }; reference_id?: string; location_id?: string }
interface SqRefund { id?: string; status?: string; payment_id?: string; location_id?: string }
interface SqDispute { id?: string; dispute_id?: string; state?: string; disputed_payment?: { payment_id?: string }; location_id?: string }
export interface SquareEvent {
  event_id: string
  type: string
  created_at: string
  data?: { type?: string; id?: string; object?: { payment?: SqPayment; refund?: SqRefund; dispute?: SqDispute } }
}

export class BadPayloadError extends Error {}

export function parseSquareEvent(rawBody: Buffer): SquareEvent {
  let parsed: unknown
  try { parsed = JSON.parse(rawBody.toString('utf8')) } catch { throw new BadPayloadError('body is not JSON') }
  const e = parsed as Partial<SquareEvent> | null
  if (!e || typeof e.event_id !== 'string' || typeof e.type !== 'string' || typeof e.created_at !== 'string') {
    throw new BadPayloadError('not a Square event envelope')
  }
  return e as SquareEvent
}

class DuplicateEvent extends Error {}
/** A refund or dispute the order rules refuse. Deterministic, so it is acknowledged (ruling T7-R1). */
class RefusedEvent extends Error {
  constructor(readonly orderError: OrderError) { super(orderError.message) }
}
/** The event cannot apply YET; the route answers 503 and Square redelivers. */
class RetryLater extends Error {}

type Tx = Prisma.TransactionClient
type Deps = { payments: PaymentsPort; email: EmailPort }

function locationOf(event: SquareEvent): string | undefined {
  const o = event.data?.object
  return o?.payment?.location_id ?? o?.refund?.location_id ?? o?.dispute?.location_id
}

async function onPaymentUpdated(tx: Tx, payment: SqPayment, deps: Deps): Promise<FollowUp | null> {
  if (!payment.id) return null
  if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
    // Ruling T4-R4: a recorded processing payment that failed no longer blocks a re-quote.
    await releaseFailedPayment(tx, payment.id)
    return null
  }
  if (payment.status !== 'COMPLETED') return null
  const ref = payment.reference_id
  const byRef = ref ? await tx.order.findUnique({ where: { id: ref }, select: { id: true } }) : null
  const order = byRef ?? await tx.order.findUnique({ where: { squarePaymentId: payment.id }, select: { id: true } })
  if (!order) {
    if (!ref) return null // not a storefront payment
    throw new RetryLater(`no order ${ref} for payment ${payment.id}`)
  }
  // Final review minor 3: only a USD amount in integer cents is comparable
  // with the order total. Anything else completes the order unchecked, loudly.
  const money = payment.amount_money
  const amount = money?.amount
  const usdCents = typeof amount === 'number' && Number.isSafeInteger(amount) && money?.currency === 'USD' ? amount : null
  if (usdCents === null) {
    console.error(
      `[square] payment ${payment.id} for order ${order.id} completed without a USD amount (amount_money: ${JSON.stringify(money ?? null)})`
      + ' -- applied without the amount check; verify the amount in the payment dashboard',
    )
  }
  const { followUp } = await applyCompletedPayment(tx, order.id, { paymentId: payment.id, amountCents: usdCents }, deps)
  return followUp
}

/**
 * The order a refund or dispute is about. Normally the one carrying the
 * payment id. On a miss (final review I1), Square's own payment names our
 * order in reference_id: if that order carries a DIFFERENT payment, this
 * payment is a duplicate we never stored. If it carries none yet, or Square's
 * payment could not be read, payment.updated may not have landed: 503, and
 * Square retries.
 */
type Resolved =
  | { kind: 'own'; orderId: string }
  | { kind: 'duplicate'; orderId: string; paymentId: string; orderPaymentId: string }

async function resolveOrder(tx: Tx, paymentId: string | undefined, payment: PaymentSummary | null): Promise<Resolved> {
  const own = paymentId ? await tx.order.findUnique({ where: { squarePaymentId: paymentId }, select: { id: true } }) : null
  if (own) return { kind: 'own', orderId: own.id }
  const ref = paymentId && payment?.id === paymentId ? payment.referenceId : null
  const byRef = ref ? await tx.order.findUnique({ where: { id: ref }, select: { id: true, squarePaymentId: true } }) : null
  if (paymentId && byRef?.squarePaymentId && byRef.squarePaymentId !== paymentId) {
    return { kind: 'duplicate', orderId: byRef.id, paymentId, orderPaymentId: byRef.squarePaymentId }
  }
  throw new RetryLater(`no order for payment ${paymentId}`)
}

/**
 * Recomputes the total of the payment's COMPLETED refunds, as read from
 * Square, and hands it to refundOrderTx, which never lowers it (§3). The
 * refund is FULL once it covers the order total OR everything Square took for
 * this payment (final review I2: an undercharged amount_mismatch order).
 */
async function onRefund(tx: Tx, refund: SqRefund, refunds: RefundSummary[], payment: PaymentSummary | null): Promise<FollowUp | null> {
  const found = await resolveOrder(tx, refund.payment_id, payment)
  const refundedCents = refunds.filter((r) => r.status === 'COMPLETED').reduce((sum, r) => sum + r.amountCents, 0)
  if (found.kind === 'duplicate') {
    // Money back from a payment the order never applied: nothing of the
    // order's changes. Recorded (the event row) and logged for the operator.
    console.error(
      `[square] refund ${refund.id ?? '?'} (${refundedCents} cents refunded so far) is on payment ${found.paymentId}, a DUPLICATE for order`
      + ` ${found.orderId}, whose payment is ${found.orderPaymentId} -- the order is unchanged`,
    )
    return null
  }
  if (!payment) throw new RetryLater(`could not read payment ${refund.payment_id} from Square`)
  const orderId = found.orderId
  const order = await lockOrderRow(tx, orderId)
  if (!order) throw new RetryLater(`order ${orderId} vanished`)
  const full = refundedCents >= order.totalCents || refundedCents >= payment.amountCents
  // Final review minor 1: the payment is recorded but its completion not yet
  // applied (pay answered processing). Wait for payment.updated.
  if (full && order.status === 'pending') throw new RetryLater(`full refund for order ${orderId}, which is still pending`)
  const { releasedVariantIds } = await refundOrderTx(tx, orderId, { refundedCents, full }, 'system')
  return releasedVariantIds.length
    ? () => enqueueInventoryPushesAfterCommit(releasedVariantIds, `square.refund order:${orderId}`)
    : null
}

async function onDispute(tx: Tx, type: string, dispute: SqDispute, payment: PaymentSummary | null): Promise<FollowUp | null> {
  const found = await resolveOrder(tx, dispute.disputed_payment?.payment_id, payment)
  const orderId = found.orderId
  // Locked, so the reviewReason read here is the one being overwritten; the prior value survives in `before`.
  const order = await lockOrderRow(tx, orderId)
  const prior = order?.reviewReason ?? null
  const disputeId = dispute.id ?? dispute.dispute_id ?? null
  const state = dispute.state ?? null
  // Either event may arrive first; both flag the order. A dispute on a
  // duplicate payment flags the order too (final review I1): it is money on
  // this order a human must answer for.
  if (prior !== 'disputed') await tx.order.update({ where: { id: orderId }, data: { reviewReason: 'disputed' } })
  await recordAudit({
    actorId: 'system',
    action: type === 'dispute.created' ? 'order.disputed' : 'order.dispute_state',
    target: `order:${orderId}`,
    before: { reviewReason: prior },
    after: { dispute: disputeId, state, reviewReason: 'disputed', ...(found.kind === 'duplicate' ? { squarePaymentId: found.paymentId } : {}) },
  }, tx)
  if (found.kind === 'duplicate') {
    console.error(`[square] dispute ${disputeId} is on payment ${found.paymentId}, a DUPLICATE for order ${orderId} (whose payment is ${found.orderPaymentId})`)
  }
  if (type === 'dispute.created') {
    console.error(`[square] order ${orderId} has a DISPUTE (${disputeId}) -- respond in the payment dashboard`)
  }
  if (state === 'LOST' || state === 'ACCEPTED') {
    console.error(`[square] order ${orderId} dispute ${disputeId} is ${state}: the money is gone -- Cancel the order in the console if it has not shipped`)
  }
  return null
}

/** Square's payment, or null when it cannot be read now (unknown id, network): the handlers then wait (503). */
async function readPayment(deps: Deps, paymentId: string): Promise<PaymentSummary | null> {
  try {
    return await deps.payments.getPayment(paymentId)
  } catch (err) {
    console.warn('[square] could not read payment', paymentId, scrubError(err))
    return null
  }
}

/** Refund and dispute paths only: an OrderError becomes a RefusedEvent (ruling T7-R1). */
async function refusable(p: Promise<FollowUp | null>): Promise<FollowUp | null> {
  try {
    return await p
  } catch (err) {
    if (err instanceof OrderError) throw new RefusedEvent(err)
    throw err
  }
}

/**
 * Applies one verified event. The PaymentEvent insert and the event's
 * effects share one transaction (§3): a crash commits neither, and a
 * concurrent or repeated delivery blocks on the primary key, then fails with
 * P2002 -> 'duplicate'. Every handler tolerates any delivery order.
 */
export async function handleSquareEvent(event: SquareEvent, deps: Deps): Promise<EventOutcome> {
  if (!HANDLED_EVENTS.has(event.type)) return 'ignored'
  const location = locationOf(event)
  if (location && location !== deps.payments.locationId) return 'ignored' // plan decision 2
  const obj = event.data?.object ?? {}

  // Read Square BEFORE the transaction: no network call while holding the order's row lock.
  let refunds: RefundSummary[] = []
  let payment: PaymentSummary | null = null
  if (event.type === 'refund.created' || event.type === 'refund.updated') {
    if (!obj.refund?.payment_id) return 'ignored'
    refunds = await deps.payments.listPaymentRefunds(obj.refund.payment_id)
    payment = await readPayment(deps, obj.refund.payment_id) // its amount decides "full" (I2)
  }
  if (event.type === 'dispute.created' || event.type === 'dispute.state.updated') {
    const disputed = obj.dispute?.disputed_payment?.payment_id
    // Only a payment no order carries needs Square's reference id (I1).
    if (disputed && !(await prisma.order.findUnique({ where: { squarePaymentId: disputed }, select: { id: true } }))) {
      payment = await readPayment(deps, disputed)
    }
  }

  let followUp: FollowUp | null = null
  try {
    followUp = await prisma.$transaction(async (tx) => {
      try {
        await tx.paymentEvent.create({ data: { provider: 'square', eventId: event.event_id, type: event.type } })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateEvent()
        throw err
      }
      switch (event.type) {
        case 'payment.updated': return onPaymentUpdated(tx, obj.payment ?? {}, deps)
        case 'refund.created':
        case 'refund.updated': return refusable(onRefund(tx, obj.refund ?? {}, refunds, payment))
        case 'dispute.created':
        case 'dispute.state.updated': return refusable(onDispute(tx, event.type, obj.dispute ?? {}, payment))
        default: return null
      }
    })
  } catch (err) {
    if (err instanceof DuplicateEvent) return 'duplicate'
    if (err instanceof RefusedEvent) {
      console.error(`[square] ${event.event_id} (${event.type}) refused: ${err.orderError.code} -- ${err.message}; acknowledging without applying, check it in the payment dashboard`)
      return 'ignored'
    }
    if (err instanceof RetryLater) {
      const created = Date.parse(event.created_at)
      if (Number.isFinite(created) && Date.now() - created >= RETRY_WINDOW_MS) {
        console.error(`[square] ${event.event_id} (${event.type}) matched no order after 24h; acknowledging without applying: ${err.message}`)
        return 'ignored'
      }
      console.warn('[square] deferring event', event.event_id, event.type, err.message)
      return 'retry'
    }
    throw err
  }
  if (followUp) await followUp()
  return 'processed'
}

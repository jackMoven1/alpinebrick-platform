import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { lockOrderRow, refundOrderTx, enqueueInventoryPushesAfterCommit, OrderError } from '../orders/orders.service.js'
import type { PaymentsPort, RefundSummary } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { applyCompletedPayment, releaseFailedPayment, type FollowUp } from './complete-payment.js'

/** Spec §3, and the five event types the runbook subscribes to. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'payment.updated', 'refund.created', 'refund.updated', 'dispute.created', 'dispute.state.updated',
])
/** Square retries a failed delivery for 24 hours; after that we log and acknowledge (P15). */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'

// Webhook payloads are raw snake_case JSON (plan header), not the SDK's camelCase types.
interface SqPayment { id?: string; status?: string; amount_money?: { amount?: number }; reference_id?: string; location_id?: string }
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
  const { followUp } = await applyCompletedPayment(tx, order.id, { paymentId: payment.id, amountCents: payment.amount_money?.amount ?? 0 }, deps)
  return followUp
}

async function orderIdByPayment(tx: Tx, paymentId: string | undefined): Promise<string> {
  const order = paymentId ? await tx.order.findUnique({ where: { squarePaymentId: paymentId }, select: { id: true } }) : null
  // Not found yet: payment.updated may not have landed. 503 -> Square retries.
  if (!order) throw new RetryLater(`no order for payment ${paymentId}`)
  return order.id
}

/**
 * Recomputes the total of the payment's COMPLETED refunds, as read from
 * Square, and hands it to refundOrderTx, which never lowers it (§3).
 */
async function onRefund(tx: Tx, refund: SqRefund, refunds: RefundSummary[]): Promise<FollowUp | null> {
  const orderId = await orderIdByPayment(tx, refund.payment_id)
  const { totalCents } = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalCents: true } })
  const refundedCents = refunds.filter((r) => r.status === 'COMPLETED').reduce((sum, r) => sum + r.amountCents, 0)
  const { releasedVariantIds } = await refundOrderTx(tx, orderId, { refundedCents, full: refundedCents >= totalCents }, 'system')
  return releasedVariantIds.length
    ? () => enqueueInventoryPushesAfterCommit(releasedVariantIds, `square.refund order:${orderId}`)
    : null
}

async function onDispute(tx: Tx, type: string, dispute: SqDispute): Promise<FollowUp | null> {
  const orderId = await orderIdByPayment(tx, dispute.disputed_payment?.payment_id)
  // Locked, so the reviewReason read here is the one being overwritten; the prior value survives in `before`.
  const order = await lockOrderRow(tx, orderId)
  const prior = order?.reviewReason ?? null
  const disputeId = dispute.id ?? dispute.dispute_id ?? null
  const state = dispute.state ?? null
  // Either event may arrive first; both flag the order.
  if (prior !== 'disputed') await tx.order.update({ where: { id: orderId }, data: { reviewReason: 'disputed' } })
  await recordAudit({
    actorId: 'system',
    action: type === 'dispute.created' ? 'order.disputed' : 'order.dispute_state',
    target: `order:${orderId}`,
    before: { reviewReason: prior },
    after: { dispute: disputeId, state, reviewReason: 'disputed' },
  }, tx)
  if (type === 'dispute.created') {
    console.error(`[square] order ${orderId} has a DISPUTE (${disputeId}) -- respond in the payment dashboard`)
  }
  if (state === 'LOST' || state === 'ACCEPTED') {
    console.error(`[square] order ${orderId} dispute ${disputeId} is ${state}: the money is gone -- Cancel the order in the console if it has not shipped`)
  }
  return null
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

  let refunds: RefundSummary[] = []
  if (event.type === 'refund.created' || event.type === 'refund.updated') {
    if (!obj.refund?.payment_id) return 'ignored'
    // Read Square BEFORE the transaction: no network call while holding the order's row lock.
    refunds = await deps.payments.listPaymentRefunds(obj.refund.payment_id)
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
        case 'refund.updated': return refusable(onRefund(tx, obj.refund ?? {}, refunds))
        case 'dispute.created':
        case 'dispute.state.updated': return refusable(onDispute(tx, event.type, obj.dispute ?? {}))
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

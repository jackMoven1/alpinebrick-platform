import Stripe from 'stripe'
import {
  type CreateCheckoutSessionInput, type PaymentsPort, type SessionPaymentStatus, type SessionStatus,
} from './payments.port.js'
import { verifyWebhookSignature } from './webhook-signature.js'

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_for_tests'

export interface FakeSession { input: CreateCheckoutSessionInput; status: SessionStatus; paymentStatus: SessionPaymentStatus }

export interface FakePaymentsPort extends PaymentsPort {
  sessions: Map<string, FakeSession>
  /** Next createCheckoutSession rejects (then resets). */
  failNextCreate: boolean
  /** Session ids passed to expireCheckoutSession, in order. */
  expired: string[]
  setSession(id: string, status: SessionStatus, paymentStatus?: SessionPaymentStatus): void
  /** A valid Stripe-Signature header for `payload` under this fake's secret. */
  sign(payload: string): string
}

/**
 * In-memory PaymentsPort for tests. Signature checks use the real stripe-node
 * implementation (an offline client) via the shared verifyWebhookSignature
 * helper (ruling P6), so webhook tests exercise genuine verification with
 * payloads signed by generateTestHeaderString.
 */
export function createFakePaymentsPort(webhookSecret = FAKE_WEBHOOK_SECRET): FakePaymentsPort {
  const offline = new Stripe('sk_test_unused_placeholder')
  const sessions = new Map<string, FakeSession>()
  let n = 0
  const fake: FakePaymentsPort = {
    configured: true,
    livemode: false,
    sessions,
    failNextCreate: false,
    expired: [],
    async createCheckoutSession(input) {
      if (fake.failNextCreate) { fake.failNextCreate = false; throw new Error('stripe is down (fake)') }
      const id = `cs_test_fake_${++n}_${Date.now()}`
      sessions.set(id, { input, status: 'open', paymentStatus: 'unpaid' })
      return { sessionId: id, clientSecret: `${id}_secret_fake` }
    },
    async expireCheckoutSession(id) {
      fake.expired.push(id)
      const s = sessions.get(id)
      if (s?.status === 'complete') return 'complete'
      if (s) s.status = 'expired'
      return 'expired'
    },
    async retrieveCheckoutSession(id) {
      const s = sessions.get(id)
      if (!s) throw new Error(`no such session ${id} (fake)`)
      return { id, status: s.status, paymentStatus: s.paymentStatus }
    },
    constructWebhookEvent(rawBody, signature) {
      return verifyWebhookSignature(offline.webhooks, rawBody, signature, webhookSecret)
    },
    setSession(id, status, paymentStatus = status === 'complete' ? 'paid' : 'unpaid') {
      const s = sessions.get(id)
      if (!s) throw new Error(`no such session ${id} (fake)`)
      s.status = status
      s.paymentStatus = paymentStatus
    },
    sign(payload) {
      return offline.webhooks.generateTestHeaderString({ payload, secret: webhookSecret })
    },
  }
  return fake
}

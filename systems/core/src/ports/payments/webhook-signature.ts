import type Stripe from 'stripe'
import { WebhookSignatureError } from './payments.port.js'

/**
 * Shared by stripe.adapter.ts and fake.adapter.ts (controller ruling P6): one
 * signature-verification helper, not a constructEvent wrapper duplicated in
 * each adapter. Both pass a real `Stripe.webhooks` instance — the live client
 * for the Stripe adapter, an offline `new Stripe(...)` for the fake — so both
 * exercise genuine stripe-node signature verification.
 */
export function verifyWebhookSignature(
  webhooks: Stripe['webhooks'],
  rawBody: Buffer,
  signature: string,
  secret: string,
): Stripe.Event {
  try {
    return webhooks.constructEvent(rawBody, signature, secret)
  } catch (err) {
    throw new WebhookSignatureError(err instanceof Error ? err.message : undefined)
  }
}

import Stripe from 'stripe'
import {
  CONTIGUOUS_US_NOTICE, SHIPPING_TAX_CODE, STRIPE_API_VERSION, TANGIBLE_GOODS_TAX_CODE,
  type CheckoutSessionState, type PaymentsPort, type SessionPaymentStatus,
} from './payments.port.js'
import { verifyWebhookSignature } from './webhook-signature.js'

export function createStripePaymentsPort(
  config: { secretKey: string; webhookSecret: string },
  client: Stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 10_000 }),
): PaymentsPort {
  const livemode = !/^(sk|rk)_test_/.test(config.secretKey)

  async function retrieve(sessionId: string): Promise<CheckoutSessionState> {
    const s = await client.checkout.sessions.retrieve(sessionId)
    return {
      id: s.id,
      status: (s.status ?? 'open') as CheckoutSessionState['status'],
      paymentStatus: s.payment_status as SessionPaymentStatus,
    }
  }

  return {
    configured: true,
    livemode,

    async createCheckoutSession(input) {
      const session = await client.checkout.sessions.create({
        // Dahlia renamed the UI modes; 'embedded' now fails (plan header).
        ui_mode: 'embedded_page',
        mode: 'payment',
        line_items: input.lines.map((l) => ({
          quantity: l.quantity,
          price_data: {
            currency: 'usd', unit_amount: l.unitAmountCents, tax_behavior: 'exclusive',
            product_data: { name: l.name, tax_code: TANGIBLE_GOODS_TAX_CODE },
          },
        })),
        automatic_tax: { enabled: true },
        // Country-level only: Stripe cannot exclude AK/HI/territories here.
        // The webhook flags them (spec §4, plan header §9.1 finding).
        shipping_address_collection: { allowed_countries: ['US'] },
        shipping_options: input.shippingOptions.map((o) => ({
          shipping_rate_data: {
            type: 'fixed_amount', display_name: o.displayName,
            fixed_amount: { amount: o.amountCents, currency: 'usd' },
            tax_behavior: 'exclusive', tax_code: SHIPPING_TAX_CODE,
          },
        })),
        // Cards only; Apple Pay and Google Pay are card wallets and remain.
        // allowed_payment_method_types exists only on PaymentIntent/SetupIntent
        // in stripe@22.6.2 (2026-08-26.dahlia) — Checkout Sessions use payment_method_types.
        payment_method_types: ['card'],
        custom_text: { shipping_address: { message: CONTIGUOUS_US_NOTICE } },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        client_reference_id: input.orderId,
        metadata: { orderId: input.orderId },
        payment_intent_data: { metadata: { orderId: input.orderId } },
        return_url: input.returnUrl,
      })
      if (!session.client_secret) throw new Error(`Stripe returned no client_secret for ${session.id}`)
      return { sessionId: session.id, clientSecret: session.client_secret }
    },

    async expireCheckoutSession(sessionId) {
      try {
        await client.checkout.sessions.expire(sessionId)
        return 'expired'
      } catch (err) {
        // Expire fails when the session is no longer open. Find out why.
        const s = await retrieve(sessionId)
        if (s.status === 'expired') return 'expired'
        if (s.status === 'complete') return 'complete'
        throw err
      }
    },

    retrieveCheckoutSession: retrieve,

    constructWebhookEvent(rawBody, signature) {
      return verifyWebhookSignature(client.webhooks, rawBody, signature, config.webhookSecret)
    },
  }
}

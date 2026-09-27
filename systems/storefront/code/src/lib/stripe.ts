import { loadStripe, type Stripe } from '@stripe/stripe-js'

let promise: Promise<Stripe | null> | null = null

/**
 * Stripe.js loads from js.stripe.com (PCI requirement; loadStripe injects
 * the script). null when this build has no publishable key -- the checkout
 * page then says it cannot load rather than failing silently.
 */
export function getStripe(): Promise<Stripe | null> | null {
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  if (!key) return null
  if (!promise) promise = loadStripe(key)
  return promise
}

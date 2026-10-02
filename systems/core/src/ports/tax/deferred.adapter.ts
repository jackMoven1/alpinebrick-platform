import type { TaxPort } from './tax.port.js'

/**
 * Storefront checkout orders are placed before Stripe knows the ship-to
 * address. Stripe Tax computes tax inside the Checkout Session (D1), and the
 * checkout.session.completed webhook writes the real figures. The MI 6%
 * flat-rate adapter stays for tests and any non-Stripe path.
 */
export const deferredTaxAdapter: TaxPort = {
  async computeTax() {
    return { taxCents: 0, rateBps: 0, jurisdiction: 'stripe_tax_pending' }
  },
}

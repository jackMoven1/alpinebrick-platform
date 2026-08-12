import type { TaxInput, TaxPort, TaxResult } from './tax.port.js'

// Nexus states and their sales-tax rate in integer basis points (600 = 6.00%).
// Michigan is AlpineBrick's only nexus state at Phase 1.
export const NEXUS_RATES_BPS: Record<string, number> = { MI: 600 }

export function createFlatRateTaxPort(rates: Record<string, number> = NEXUS_RATES_BPS): TaxPort {
  return {
    async computeTax(input: TaxInput): Promise<TaxResult> {
      const state = input.shipToState.trim().toUpperCase()
      const rateBps = rates[state] ?? 0
      const subtotalCents = input.lineItems.reduce((sum, li) => sum + li.amountCents, 0)
      const taxCents = Math.round((subtotalCents * rateBps) / 10000)
      return { taxCents, rateBps, jurisdiction: rateBps > 0 ? state : 'none' }
    },
  }
}

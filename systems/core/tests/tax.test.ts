import { describe, it, expect } from 'vitest'
import { createFlatRateTaxPort, NEXUS_RATES_BPS } from '../src/ports/tax/flat-rate.adapter.js'

describe('flat-rate tax port', () => {
  const tax = createFlatRateTaxPort()

  it('charges Michigan 6% on the subtotal, rounded to the nearest cent', async () => {
    const r = await tax.computeTax({ shipToState: 'MI', lineItems: [{ amountCents: 4999 }] })
    expect(r.taxCents).toBe(300)      // 4999 * 600 / 10000 = 299.94 -> 300
    expect(r.rateBps).toBe(600)
    expect(r.jurisdiction).toBe('MI')
  })

  it('sums multiple line items before applying the rate', async () => {
    const r = await tax.computeTax({ shipToState: 'mi', lineItems: [{ amountCents: 1000 }, { amountCents: 2000 }] })
    expect(r.taxCents).toBe(180)      // 3000 * 6%
  })

  it('charges zero tax for a non-nexus state', async () => {
    const r = await tax.computeTax({ shipToState: 'CA', lineItems: [{ amountCents: 5000 }] })
    expect(r.taxCents).toBe(0)
    expect(r.rateBps).toBe(0)
    expect(r.jurisdiction).toBe('none')
  })

  it('exposes Michigan as the only default nexus state', () => {
    expect(NEXUS_RATES_BPS).toEqual({ MI: 600 })
  })
})

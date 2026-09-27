import { describe, it, expect } from 'vitest'
import { createFlatRateShippingPort } from '../src/ports/shipping/flat-rate.adapter.js'

const settings = (freeThresholdCents: number | null) => async () =>
  ({ flatRateCents: 995, freeThresholdCents, sessionMinutes: 30 })

describe('flat-rate shipping', () => {
  it('charges the flat rate below the threshold', async () => {
    const port = createFlatRateShippingPort(settings(15000))
    expect(await port.quote({ subtotalCents: 14999, lines: [] }))
      .toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
  })

  it('is free at or above the threshold', async () => {
    const port = createFlatRateShippingPort(settings(15000))
    expect(await port.quote({ subtotalCents: 15000, lines: [] }))
      .toEqual([{ displayName: 'Free shipping', amountCents: 0 }])
  })

  it('never frees shipping when the threshold is null', async () => {
    const port = createFlatRateShippingPort(settings(null))
    expect(await port.quote({ subtotalCents: 1_000_000, lines: [] }))
      .toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
  })
})

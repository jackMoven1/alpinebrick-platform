import { describe, it, expect } from 'vitest'
import { toCents, toCanonicalOrder, toItemFeed, toInventoryPayload, toPricePayload, toShipPayload, centsToDollars } from '../src/channels/walmart/mappers.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

describe('walmart mappers', () => {
  it('toCents rounds decimal dollars', () => {
    expect(toCents(49.99)).toBe(4999)
    expect(toCents(3.0)).toBe(300)
    expect(toCents(0.015)).toBe(2)
  })

  it('maps a walmart order to canonical form (per-unit charges multiplied by qty downstream)', () => {
    const o = toCanonicalOrder(walmartOrderFixture)
    expect(o).toEqual({
      externalOrderId: 'PO-1001',
      email: 'mgr@relay.walmart.com',
      shipToState: 'MI',
      lines: [{ walmartSku: 'ABE-SET-001-W', quantity: 2, unitPriceCents: 4999, lineTaxCents: 600 }],
    })
  })

  it('falls back to placeholder email and rejects unmappable payloads', () => {
    const noEmail = { ...walmartOrderFixture, customerEmailId: undefined }
    expect(toCanonicalOrder(noEmail).email).toBe('walmart-customer@channel.local')
    expect(() => toCanonicalOrder({})).toThrow(/unmappable_order/)
  })

  it('builds an item spec 5.x feed', () => {
    const feed = toItemFeed([{ walmartSku: 'ABE-1-W', name: 'Set', description: 'Bricks', priceCents: 4999, imageUrls: ['https://img/1.jpg'] }]) as any
    expect(feed.MPItemFeedHeader.version).toBe('5.0')
    expect(feed.MPItem).toHaveLength(1)
    expect(feed.MPItem[0].Orderable.sku).toBe('ABE-1-W')
    expect(feed.MPItem[0].Orderable.price).toBe(49.99)
  })

  it('builds inventory, price, and ship payloads', () => {
    expect(toInventoryPayload('ABE-1-W', 7)).toEqual({ sku: 'ABE-1-W', quantity: { unit: 'EACH', amount: 7 } })
    const price = toPricePayload('ABE-1-W', 4999) as any
    expect(price.pricing[0].currentPrice.amount).toBe(49.99)
    const ship = toShipPayload({ lineNumbers: ['1'], quantityByLine: { '1': 2 }, carrier: 'USPS', trackingNumber: 'T123', shipDateIso: '2026-08-03T12:00:00Z' }) as any
    expect(ship.orderShipment.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].trackingInfo.trackingNumber).toBe('T123')
  })

  // The one outbound cents -> decimal-dollars boundary. `1999/100` round-trips
  // cleanly by luck of float formatting; these values are chosen to be the
  // ones most likely to expose a sloppy conversion (non-round cents, sub-dollar,
  // zero, and a large price), and the assertion is on the SERIALISED wire
  // string, not just the JS number -- a test comparing numbers can pass while
  // the JSON actually sent to Walmart is wrong (e.g. `19.989999999999998`).
  it('centsToDollars converts exactly, verified on the serialised string', () => {
    const cases: Array<[number, number, string]> = [
      [1, 0.01, '0.01'],
      [7, 0.07, '0.07'],
      [33, 0.33, '0.33'],
      [99, 0.99, '0.99'],
      [100, 1, '1'],
      [1999, 19.99, '19.99'],
      [4999, 49.99, '49.99'],
      [0, 0, '0'],
      [999999999, 9999999.99, '9999999.99'],
      [1000000001, 10000000.01, '10000000.01'],
    ]
    for (const [cents, amount, serialised] of cases) {
      const got = centsToDollars(cents)
      expect(got, `centsToDollars(${cents})`).toBe(amount)
      expect(JSON.stringify(got), `JSON.stringify(centsToDollars(${cents}))`).toBe(serialised)
    }
  })

  it('toPricePayload serialises the exact wire body for tricky cent values', () => {
    const cases: Array<[number, string]> = [
      [7, '0.07'],
      [999999999, '9999999.99'],
      [0, '0'],
    ]
    for (const [cents, amount] of cases) {
      const payload = toPricePayload('SKU-W', cents)
      expect(JSON.stringify(payload)).toBe(
        JSON.stringify({ sku: 'SKU-W', pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: centsToDollars(cents) } }] }),
      )
      expect(JSON.stringify(payload)).toContain(`"amount":${amount}`)
    }
  })
})

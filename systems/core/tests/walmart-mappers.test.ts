import { describe, it, expect } from 'vitest'
import { toCents, toCanonicalOrder, toItemFeed, toInventoryPayload, toPricePayload, toShipPayload } from '../src/channels/walmart/mappers.js'

// Trimmed from a real sandbox order response shape (Orders API v3).
export const walmartOrderFixture = {
  purchaseOrderId: 'PO-1001',
  customerOrderId: 'CO-9001',
  customerEmailId: 'mgr@relay.walmart.com',
  orderDate: 1754160000000,
  shippingInfo: { postalAddress: { state: 'MI', postalCode: '48823' } },
  orderLines: {
    orderLine: [
      {
        lineNumber: '1',
        item: { sku: 'ABE-SET-001-W', productName: 'Castle Set' },
        orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '2' },
        charges: {
          charge: [
            {
              chargeType: 'PRODUCT',
              chargeAmount: { currency: 'USD', amount: 49.99 },
              tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 3.0 } },
            },
          ],
        },
      },
    ],
  },
}

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
})

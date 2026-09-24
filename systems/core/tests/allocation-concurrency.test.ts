import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { placeOrder } from '../src/orders/orders.service.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

// Split stock must be un-oversellable: a storefront checkout and a Walmart
// ingest racing for one variant can each take only their own share.
// Verified non-vacuous by mutation (see PR): dropping
// "- COALESCE(walmart_allocation, 0)" from placeOrder's guard makes this fail.
beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

function walmartPo(n: number) {
  return { ...walmartOrderFixture, purchaseOrderId: `PO-RACE-${n}`, customerOrderId: `CO-RACE-${n}` }
}

describe('allocation under concurrency', () => {
  it('storefront never takes Walmart units and neither side oversells', async () => {
    for (let round = 0; round < 10; round++) {
      await resetDb(); await ensureSystemActor()
      const p = await prisma.product.create({ data: { slug: 'r', name: 'R', productType: 'resale', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
      // 4 on hand: 2 for Walmart (one PO of qty 2), 2 for the storefront.
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 4, walmartAllocation: 2 } })
      await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })

      await Promise.allSettled([
        ...Array.from({ length: 6 }, () =>
          placeOrder({ email: 'r@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })),
        ...Array.from({ length: 3 }, (_, i) => ingestWalmartOrder(walmartPo(round * 10 + i), 'webhook')),
      ])

      const i = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
      const storefrontReserved = await prisma.orderLine.aggregate({
        where: { variantId: v.id, order: { channel: 'storefront' } }, _sum: { quantity: true },
      })
      expect(i.reserved + (i.walmartAllocation ?? 0)).toBeLessThanOrEqual(i.onHand)
      expect(storefrontReserved._sum.quantity ?? 0).toBeLessThanOrEqual(2)
      expect(i.walmartAllocation).toBe(0)
      expect(i.reserved).toBe(4)
    }
  })
})

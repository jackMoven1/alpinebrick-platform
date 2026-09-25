import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { placeOrder } from '../src/orders/orders.service.js'
import { setStock } from '../src/admin/stock.service.js'

// A stock set racing checkouts must never leave reserved above on-hand.
// Verified non-vacuous by mutation (see PR): remove "FOR UPDATE" from
// setStock's SELECT and the guard from its UPDATE, and this fails.
beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

describe('setStock under concurrency', () => {
  it('never lets reserved exceed on-hand', async () => {
    for (let round = 0; round < 20; round++) {
      await resetDb(); await ensureSystemActor()
      const p = await prisma.product.create({ data: { slug: 'c', name: 'C', productType: 'resale', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku: 'C-1', priceCents: 100 } })
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })

      await Promise.allSettled([
        ...Array.from({ length: 8 }, () =>
          placeOrder({ email: 'c@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })),
        setStock(v.id, { onHand: 4 }, 'system'),
      ])

      const i = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
      expect(i.reserved).toBeLessThanOrEqual(i.onHand)
    }
  })
})

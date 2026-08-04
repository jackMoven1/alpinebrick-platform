import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('schema', () => {
  it('creates a product with a variant and inventory', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'test-set', name: 'Test Set', productType: 'own_designed', status: 'published',
        variants: { create: { sku: 'TS-1', priceCents: 1999, inventory: { create: { onHand: 5 } } } },
      },
      include: { variants: { include: { inventory: true } } },
    })
    expect(p.variants[0].sku).toBe('TS-1')
    expect(p.variants[0].inventory?.onHand).toBe(5)
  })
})

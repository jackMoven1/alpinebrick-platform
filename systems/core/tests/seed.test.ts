import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('seed', () => {
  it('creates both product lines with inventory and a system actor', async () => {
    await seed()
    const products = await prisma.product.findMany({ include: { variants: { include: { inventory: true } } } })
    expect(products).toHaveLength(2)
    expect(products.map(p => p.productType).sort()).toEqual(['own_designed', 'resale'])
    expect(products.every(p => p.variants.every(v => v.inventory && v.inventory.onHand > 0))).toBe(true)
    const actor = await prisma.actor.findFirst({ where: { name: 'system' } })
    expect(actor?.type).toBe('human')
  })

  it('is idempotent (running twice does not duplicate)', async () => {
    await seed(); await seed()
    expect(await prisma.product.count()).toBe(2)
  })
})

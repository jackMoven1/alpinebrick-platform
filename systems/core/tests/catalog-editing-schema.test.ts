import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { setProductStatus } from '../src/admin/admin-catalog.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('first_published_at', () => {
  it('is null on a new product', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    expect(p.firstPublishedAt).toBeNull()
  })

  it('is stamped on first publish and never cleared or moved', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    await setProductStatus(p.id, 'published', actorId)
    const first = (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).firstPublishedAt
    expect(first).toBeInstanceOf(Date)
    await setProductStatus(p.id, 'draft', actorId)
    await setProductStatus(p.id, 'published', actorId)
    await setProductStatus(p.id, 'archived', actorId)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).firstPublishedAt).toEqual(first)
  })
})

describe('walmart_allocation', () => {
  async function inv() {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'A-1', priceCents: 100 } })
    return prisma.inventory.create({ data: { variantId: v.id, onHand: 1 } })
  }
  it('defaults to null (shared)', async () => {
    expect((await inv()).walmartAllocation).toBeNull()
  })
  it('rejects a negative allocation at the database', async () => {
    const i = await inv()
    await expect(prisma.$executeRaw`UPDATE inventory SET walmart_allocation = -1 WHERE id = ${i.id}`).rejects.toThrow()
  })
})

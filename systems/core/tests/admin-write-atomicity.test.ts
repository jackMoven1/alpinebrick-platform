import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('../src/audit.js', () => ({
  recordAudit: vi.fn(async () => { throw new Error('audit down') }),
}))

import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createProduct, updateProduct } from '../src/admin/product-write.service.js'
import { createVariant } from '../src/admin/variant-write.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('a write whose audit fails is undone', () => {
  it('create', async () => {
    await expect(createProduct({ name: 'A', productType: 'resale' }, actorId)).rejects.toThrow('audit down')
    expect(await prisma.product.count()).toBe(0)
  })
  it('update', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    await expect(updateProduct(p.id, { name: 'B' }, actorId)).rejects.toThrow('audit down')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).name).toBe('A')
  })
  it('createVariant', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    await expect(createVariant(p.id, { sku: 'A-1', priceCents: 100 }, actorId)).rejects.toThrow('audit down')
    expect(await prisma.variant.count()).toBe(0)
    expect(await prisma.inventory.count()).toBe(0)
  })
})

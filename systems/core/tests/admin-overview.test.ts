import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { getOverview } from '../src/admin/admin-catalog.service.js'

async function make(slug: string, status: 'draft' | 'published' | 'archived', variants = 1) {
  return prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: Array.from({ length: variants }, (_, i) => ({ sku: `${slug}-${i}`, priceCents: 100 })) },
    },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('getOverview', () => {
  it('counts products by status', async () => {
    await make('d1', 'draft'); await make('d2', 'draft')
    await make('p1', 'published')
    await make('a1', 'archived')
    const o = await getOverview()
    expect(o).toMatchObject({ totalProducts: 4, draft: 2, published: 1, archived: 1 })
  })

  it('returns zeroes on an empty catalogue rather than throwing', async () => {
    const o = await getOverview()
    expect(o).toMatchObject({ totalProducts: 0, draft: 0, published: 0, archived: 0 })
    expect(o.recentlyModified).toEqual([])
  })

  it('lists the five most recently modified, newest first', async () => {
    for (const s of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      await make(s, 'draft')
      await new Promise(r => setTimeout(r, 3))
    }
    const o = await getOverview()
    expect(o.recentlyModified).toHaveLength(5)
    expect(o.recentlyModified[0]!.slug).toBe('p6')
  })

  it('flags products with no variants, which cannot be sold', async () => {
    await make('sellable', 'draft', 1)
    await make('unsellable', 'draft', 0)
    const o = await getOverview()
    expect(o.missingVariants.map(p => p.slug)).toEqual(['unsellable'])
  })

  it('does not flag archived products as missing variants', async () => {
    await make('archived-empty', 'archived', 0)
    const o = await getOverview()
    expect(o.missingVariants).toEqual([])
  })

  // Every product has placeholder images, so this check would report all-clear
  // while every product is in fact missing real photography.
  it('does NOT report missingImages', async () => {
    const o = await getOverview()
    expect(o).not.toHaveProperty('missingImages')
  })
})

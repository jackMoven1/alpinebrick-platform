import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { adminListProducts, adminGetProduct, AdminError } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct, listProducts as publicListProducts } from '../src/catalog/catalog.service.js'

async function make(slug: string, status: 'draft' | 'published' | 'archived', variants = 1, images = 1) {
  const p = await prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: Array.from({ length: variants }, (_, i) => ({ sku: `${slug}-${i}`, priceCents: 1000 })) },
    },
  })
  if (images > 0) {
    await prisma.image.createMany({
      data: Array.from({ length: images }, (_, i) => ({
        productId: p.id, storageKey: `products/${p.id}/i${i}/original.jpg`,
        alt: 'x', position: i, width: 10, height: 10,
        contentType: 'image/jpeg', byteSize: 1, status: 'ready' as const,
      })),
    })
  }
  return p
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('adminListProducts', () => {
  it('returns products of EVERY status by default', async () => {
    await make('a-draft', 'draft')
    await make('b-published', 'published')
    await make('c-archived', 'archived')
    const r = await adminListProducts({})
    expect(r.items.map(i => i.slug).sort()).toEqual(['a-draft', 'b-published', 'c-archived'])
    expect(r.total).toBe(3)
  })

  // The reason a separate admin surface exists at all.
  it('sees a draft that the public list does not', async () => {
    await make('secret-draft', 'draft')
    const admin = await adminListProducts({})
    const pub = await publicListProducts({})
    expect(admin.items.map(i => i.slug)).toContain('secret-draft')
    expect(pub.items.map(i => i.slug)).not.toContain('secret-draft')
  })

  it('narrows to a single status when asked', async () => {
    await make('a-draft', 'draft')
    await make('b-published', 'published')
    const r = await adminListProducts({ status: 'draft' })
    expect(r.items.map(i => i.slug)).toEqual(['a-draft'])
  })

  it('rejects an unknown status rather than silently returning everything', async () => {
    await expect(adminListProducts({ status: 'bogus' })).rejects.toThrow(AdminError)
  })

  it('counts variants and images per product', async () => {
    await make('counted', 'draft', 3, 2)
    const r = await adminListProducts({})
    expect(r.items[0]).toMatchObject({ variantCount: 3, imageCount: 2 })
  })

  it('searches by name, case-insensitively', async () => {
    await make('dragon-fortress', 'draft')
    await make('coral-reef', 'draft')
    const r = await adminListProducts({ search: 'DRAGON' })
    expect(r.items.map(i => i.slug)).toEqual(['dragon-fortress'])
  })

  it('paginates and reports the full total', async () => {
    for (const s of ['p1', 'p2', 'p3']) await make(s, 'draft')
    const r = await adminListProducts({ page: 2, pageSize: 2 })
    expect(r.items).toHaveLength(1)
    expect(r.total).toBe(3)
  })

  it('exposes updatedAt for the last-modified column', async () => {
    await make('stamped', 'draft')
    const r = await adminListProducts({})
    expect(r.items[0]!.updatedAt).toBeInstanceOf(Date)
  })
})

describe('adminGetProduct', () => {
  it('loads a draft, which the public route refuses', async () => {
    const p = await make('draft-detail', 'draft')
    expect((await adminGetProduct(p.id))?.slug).toBe('draft-detail')
    expect(await publicGetProduct(p.id)).toBeNull()
  })

  it('loads an archived product', async () => {
    const p = await make('archived-detail', 'archived')
    expect((await adminGetProduct(p.id))?.slug).toBe('archived-detail')
  })

  it('returns null for an unknown id', async () => {
    expect(await adminGetProduct('nope')).toBeNull()
  })
})

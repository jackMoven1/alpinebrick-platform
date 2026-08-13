import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { getProduct, toStringArray } from '../src/catalog/catalog.service.js'
import { resetDb } from './helpers/db.js'

describe('catalog DTO', () => {
  beforeAll(async () => {
    await resetDb()
    const p = await prisma.product.create({
      data: {
        slug: 'dto-fixture', name: 'DTO Fixture', productType: 'own_designed',
        status: 'published', pieces: 100, difficulty: 'beginner',
        categories: ['architecture'],
        features: ['One'], includes: ['Two'],
        homePosition: 5, collectionPosition: 9,
      },
    })
    await prisma.image.createMany({
      data: [
        { productId: p.id, storageKey: `products/${p.id}/b/original.jpg`, alt: 'Second', position: 1, width: 800, height: 600, contentType: 'image/jpeg', byteSize: 10, status: 'ready' },
        { productId: p.id, storageKey: `products/${p.id}/a/original.jpg`, alt: 'First', position: 0, width: 900, height: 720, contentType: 'image/jpeg', byteSize: 10, status: 'ready' },
        { productId: p.id, storageKey: `products/${p.id}/p/original.jpg`, alt: 'Not ready', position: 2, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1, status: 'pending' },
      ],
    })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('returns categories and detail fields', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.categories).toEqual(['architecture'])
    expect(p?.pieces).toBe(100)
    expect(p?.difficulty).toBe('beginner')
    expect(p?.features).toEqual(['One'])
    expect(p?.includes).toEqual(['Two'])
  })

  it('returns images from the relation, ordered by position', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.images.map(i => i.alt)).toEqual(['First', 'Second'])
    expect(p?.images[0]).toMatchObject({ position: 0, width: 900, height: 720 })
    expect(p?.images[0]!.storageKey).toContain('/a/original.jpg')
  })

  // A half-uploaded image must never reach a customer.
  it('excludes pending images', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.images.some(i => i.alt === 'Not ready')).toBe(false)
  })

  it('returns no url field — the client resolves URLs from the key', async () => {
    const p = await getProduct('dto-fixture')
    for (const img of p?.images ?? []) {
      expect((img as unknown as Record<string, unknown>).url).toBeUndefined()
    }
  })

  it('exposes both display positions and createdAt', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.homePosition).toBe(5)
    expect(p?.collectionPosition).toBe(9)
    // createdAt drives the "New" badge on the storefront.
    expect(p?.createdAt).toBeInstanceOf(Date)
  })

  // The images coercion test that lived here is gone deliberately: images are
  // now a real table with typed columns, so there is no malformed shape for
  // Postgres to let through. categories/features/includes are still JSON.
  it('coerces malformed string arrays to an empty array', () => {
    expect(toStringArray(null)).toEqual([])
    expect(toStringArray({})).toEqual([])
    expect(toStringArray(['a', 2, 'b'])).toEqual(['a', 'b'])
  })
})

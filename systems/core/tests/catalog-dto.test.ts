import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { getProduct, toImages, toStringArray } from '../src/catalog/catalog.service.js'
import { resetDb } from './helpers/db.js'

describe('catalog DTO', () => {
  beforeAll(async () => {
    await resetDb()
    await prisma.product.create({
      data: {
        slug: 'dto-fixture', name: 'DTO Fixture', productType: 'own_designed',
        status: 'published', pieces: 100, difficulty: 'beginner',
        images: [{ url: '/img/a.jpg', alt: 'Front view' }],
        categories: ['architecture'],
        features: ['One'], includes: ['Two'],
        homePosition: 5, collectionPosition: 9,
      },
    })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('returns images and categories instead of dropping them', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.images).toEqual([{ url: '/img/a.jpg', alt: 'Front view' }])
    expect(p?.categories).toEqual(['architecture'])
    expect(p?.pieces).toBe(100)
    expect(p?.difficulty).toBe('beginner')
    expect(p?.features).toEqual(['One'])
    expect(p?.includes).toEqual(['Two'])
  })

  it('exposes both display positions and createdAt', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.homePosition).toBe(5)
    expect(p?.collectionPosition).toBe(9)
    // createdAt drives the "New" badge on the storefront.
    expect(p?.createdAt).toBeInstanceOf(Date)
  })

  // Json columns are unvalidated at the database boundary. A corrupt value
  // must render as empty, never propagate to the client or crash the grid.
  it('coerces malformed images to an empty array', () => {
    expect(toImages(null)).toEqual([])
    expect(toImages('not-an-array')).toEqual([])
    expect(toImages([{ url: 'x' }])).toEqual([])          // missing alt
    expect(toImages([{ url: 1, alt: 2 }])).toEqual([])      // wrong types
    expect(toImages([{ url: 'a', alt: 'b' }, 'junk'])).toEqual([{ url: 'a', alt: 'b' }])
  })

  it('coerces malformed string arrays to an empty array', () => {
    expect(toStringArray(null)).toEqual([])
    expect(toStringArray({})).toEqual([])
    expect(toStringArray(['a', 2, 'b'])).toEqual(['a', 'b'])
  })
})

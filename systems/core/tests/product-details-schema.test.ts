import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

describe('product detail columns', () => {
  beforeAll(async () => { await resetDb() })
  afterAll(async () => { await prisma.$disconnect() })

  it('persists and returns every detail field', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'detail-fixture', name: 'Detail Fixture',
        productType: 'own_designed', status: 'published',
        pieces: 2847,
        difficulty: 'expert',
        ageRecommendation: '16+',
        dimensions: '68 x 32 x 48 cm',
        longDescription: 'A long form description.',
        features: ['Opening doors', 'Poseable bridge'],
        includes: ['6 minifigures', 'Display nameplate'],
        builderNotes: 'The bridge took weeks.',
      },
    })
    const found = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(found.pieces).toBe(2847)
    expect(found.difficulty).toBe('expert')
    expect(found.ageRecommendation).toBe('16+')
    expect(found.dimensions).toBe('68 x 32 x 48 cm')
    expect(found.longDescription).toBe('A long form description.')
    expect(found.features).toEqual(['Opening doors', 'Poseable bridge'])
    expect(found.includes).toEqual(['6 minifigures', 'Display nameplate'])
    expect(found.builderNotes).toBe('The bridge took weeks.')
  })

  // Unranked products must sort LAST, so the columns are nullable rather than
  // defaulted to 0 — a 0 default would promote every new product to the top.
  it('persists both display positions independently', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'position-fixture', name: 'Position Fixture',
        productType: 'resale', status: 'published',
        homePosition: 3, collectionPosition: 17,
      },
    })
    expect(p.homePosition).toBe(3)
    expect(p.collectionPosition).toBe(17)
  })

  it('defaults every detail field so existing rows stay valid', async () => {
    const p = await prisma.product.create({
      data: { slug: 'bare-fixture', name: 'Bare', productType: 'resale', status: 'published' },
    })
    expect(p.pieces).toBeNull()
    expect(p.difficulty).toBeNull()
    expect(p.ageRecommendation).toBeNull()
    expect(p.dimensions).toBeNull()
    expect(p.longDescription).toBe('')
    expect(p.features).toEqual([])
    expect(p.includes).toEqual([])
    expect(p.builderNotes).toBe('')
    expect(p.homePosition).toBeNull()
    expect(p.collectionPosition).toBeNull()
  })
})

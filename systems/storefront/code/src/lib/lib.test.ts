import { describe, it, expect } from 'vitest'
import { formatCents, minPriceCents } from './money'
import { deriveBadge } from './badge'
import { COLLECTIONS, CATEGORY_COLLECTIONS, findCollection } from './collections'
import type { Product } from './api/types'

function product(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', slug: 's', name: 'N', description: '',
    productType: 'resale', releaseType: 'standard', status: 'published',
    images: [], categories: [], pieces: null, difficulty: null,
    ageRecommendation: null, dimensions: null, longDescription: '',
    features: [], includes: [], builderNotes: '',
    homePosition: null, collectionPosition: null,
    createdAt: '2020-01-01T00:00:00Z',
    variants: [],
    ...over,
  }
}

describe('formatCents', () => {
  it('formats whole dollars', () => expect(formatCents(18900)).toBe('$189.00'))
  it('keeps both decimal places', () => expect(formatCents(9)).toBe('$0.09'))
  it('groups thousands', () => expect(formatCents(123456)).toBe('$1,234.56'))
  it('formats zero', () => expect(formatCents(0)).toBe('$0.00'))
})

describe('minPriceCents', () => {
  it('returns the cheapest variant price', () => {
    const p = product({
      variants: [
        { id: '1', sku: 'a', priceCents: 5000, currency: 'USD' },
        { id: '2', sku: 'b', priceCents: 3000, currency: 'USD' },
      ],
    })
    expect(minPriceCents(p)).toBe(3000)
  })

  it('returns null when there are no variants', () => {
    expect(minPriceCents(product())).toBeNull()
  })
})

describe('deriveBadge', () => {
  const NOW = new Date('2026-08-12T00:00:00Z')

  it('labels a limited run', () => {
    expect(deriveBadge(product({ releaseType: 'limited_run' }), NOW)).toBe('Limited')
  })

  it('labels a recent standard product New', () => {
    expect(deriveBadge(product({ createdAt: '2026-08-01T00:00:00Z' }), NOW)).toBe('New')
  })

  it('returns null for an older standard product', () => {
    expect(deriveBadge(product({ createdAt: '2025-01-01T00:00:00Z' }), NOW)).toBeNull()
  })

  // Limited outranks New so a product cannot claim two badges at once.
  it('prefers Limited over New when both apply', () => {
    expect(
      deriveBadge(product({ releaseType: 'limited_run', createdAt: '2026-08-11T00:00:00Z' }), NOW),
    ).toBe('Limited')
  })

  it('returns null for an unparseable createdAt rather than throwing', () => {
    expect(deriveBadge(product({ createdAt: 'not-a-date' }), NOW)).toBeNull()
  })
})

describe('collection registry', () => {
  it('defines all seven collections', () => {
    expect(COLLECTIONS.map(c => c.slug).sort()).toEqual([
      'architecture', 'fantasy', 'limited-edition', 'nature',
      'new-arrivals', 'ocean', 'space',
    ])
  })

  it('maps a category collection to a category query in collection display order', () => {
    expect(findCollection('architecture')?.query).toEqual({
      category: 'architecture', sort: 'collection_display',
    })
  })

  it('maps limited-edition through a category, not a releaseType filter', () => {
    expect(findCollection('limited-edition')?.query).toEqual({
      category: 'limited-edition', sort: 'collection_display',
    })
  })

  // "Recently added" is intrinsically chronological — hand-merchandising it
  // would mean re-ranking on every new product.
  it('maps new-arrivals to the newest sort, not a display order', () => {
    expect(findCollection('new-arrivals')?.query).toEqual({ sort: 'newest' })
  })

  it('never uses home_display for a collection', () => {
    for (const c of COLLECTIONS) expect(c.query.sort).not.toBe('home_display')
  })

  // An unknown slug must 404 rather than render an empty grid, which would tell
  // a customer the collection exists but is empty.
  it('returns undefined for an unknown slug', () => {
    expect(findCollection('nope')).toBeUndefined()
  })

  it('gives every collection a title and blurb', () => {
    for (const c of COLLECTIONS) {
      expect(c.title.length).toBeGreaterThan(0)
      expect(c.blurb.length).toBeGreaterThan(0)
    }
  })

  it('uses lowercase kebab-case slugs', () => {
    for (const c of COLLECTIONS) expect(c.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('exposes exactly the five category-backed collections for the home filter', () => {
    expect(CATEGORY_COLLECTIONS.map(c => c.slug)).toEqual([
      'architecture', 'fantasy', 'space', 'ocean', 'nature',
    ])
  })
})

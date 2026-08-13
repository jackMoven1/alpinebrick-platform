import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { listProducts, CatalogValidationError } from '../src/catalog/catalog.service.js'
import { resetDb } from './helpers/db.js'

async function make(
  slug: string, name: string, cats: string[], prices: number[],
  positions: { home?: number | null; collection?: number | null } = {},
) {
  return prisma.product.create({
    data: {
      slug, name, productType: 'resale', status: 'published', categories: cats,
      homePosition: positions.home ?? null,
      collectionPosition: positions.collection ?? null,
      variants: { create: prices.map((p, i) => ({ sku: `${slug}-${i}`, priceCents: p })) },
    },
  })
}

describe('catalog filtering and sorting', () => {
  beforeAll(async () => {
    await resetDb()
    // Home and collection positions are deliberately in DIFFERENT orders so the
    // tests prove the two sorts are independent rather than coincidentally equal.
    await make('alpha',   'Alpha Set',   ['architecture'],          [5000, 3000], { home: 2, collection: 30 })
    await make('bravo',   'Bravo Set',   ['fantasy'],               [1000],       { home: 1, collection: 40 })
    await make('charlie', 'Charlie Set', ['architecture', 'space'], [9000],       { home: 3, collection: 10 })
    await make('delta',   'Delta Set',   [],                        [],           { home: null, collection: 20 })
    await make('echo',    'Echo Set',    ['fantasy'],               [2000],       { home: 2, collection: null })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('filters to products containing the category', async () => {
    const r = await listProducts({ category: 'architecture' })
    expect(r.items.map(i => i.slug).sort()).toEqual(['alpha', 'charlie'])
    expect(r.total).toBe(2)
  })

  it('matches a category anywhere in the array, not just first', async () => {
    const r = await listProducts({ category: 'space' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie'])
  })

  it('returns nothing for an unknown category rather than everything', async () => {
    const r = await listProducts({ category: 'nonexistent' })
    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
  })

  // ADR-0001: sort by the product's CHEAPEST variant. Alpha's cheapest is 3000,
  // so it must precede Charlie at 9000 despite also having a 5000 variant.
  it('sorts ascending by cheapest variant, variantless last', async () => {
    const r = await listProducts({ sort: 'price_asc' })
    expect(r.items.map(i => i.slug)).toEqual(['bravo', 'echo', 'alpha', 'charlie', 'delta'])
  })

  it('sorts descending by cheapest variant, variantless last', async () => {
    const r = await listProducts({ sort: 'price_desc' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'alpha', 'echo', 'bravo', 'delta'])
  })

  it('sorts by name ascending by default', async () => {
    const r = await listProducts({})
    expect(r.items.map(i => i.slug)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
  })

  it('paginates against the full filtered set, not the page', async () => {
    const r = await listProducts({ sort: 'price_asc', page: 2, pageSize: 2 })
    expect(r.items.map(i => i.slug)).toEqual(['alpha', 'charlie'])
    expect(r.total).toBe(5)
    expect(r.page).toBe(2)
    expect(r.pageSize).toBe(2)
  })

  it('combines search with category', async () => {
    const r = await listProducts({ category: 'architecture', search: 'charlie' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie'])
  })

  it('orders by home position, unranked last, ties broken by name', async () => {
    const r = await listProducts({ sort: 'home_display' })
    // bravo=1, alpha=2, echo=2 (tie -> name), charlie=3, delta=null -> last
    expect(r.items.map(i => i.slug)).toEqual(['bravo', 'alpha', 'echo', 'charlie', 'delta'])
  })

  it('orders by collection position, unranked last', async () => {
    const r = await listProducts({ sort: 'collection_display' })
    // charlie=10, delta=20, alpha=30, bravo=40, echo=null -> last
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'delta', 'alpha', 'bravo', 'echo'])
  })

  // The whole point of two columns: the same catalogue orders differently
  // depending on where it is being shown.
  it('gives home and collection genuinely different orders', async () => {
    const home = await listProducts({ sort: 'home_display' })
    const coll = await listProducts({ sort: 'collection_display' })
    expect(home.items.map(i => i.slug)).not.toEqual(coll.items.map(i => i.slug))
  })

  it('applies the collection display order within a filtered category', async () => {
    const r = await listProducts({ category: 'architecture', sort: 'collection_display' })
    // charlie=10 before alpha=30
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'alpha'])
  })

  it('paginates stably under a display sort', async () => {
    const p1 = await listProducts({ sort: 'home_display', page: 1, pageSize: 2 })
    const p2 = await listProducts({ sort: 'home_display', page: 2, pageSize: 2 })
    expect(p1.items.map(i => i.slug)).toEqual(['bravo', 'alpha'])
    expect(p2.items.map(i => i.slug)).toEqual(['echo', 'charlie'])
  })

  // A silently ignored bad parameter returns plausible wrong results, which is
  // harder to notice than an error.
  it('rejects an unknown sort instead of falling back', async () => {
    await expect(listProducts({ sort: 'cheapest' as any })).rejects.toThrow(CatalogValidationError)
  })

  it('rejects a non-positive page', async () => {
    await expect(listProducts({ page: 0 })).rejects.toThrow(CatalogValidationError)
  })

  it('rejects a pageSize above 100', async () => {
    await expect(listProducts({ pageSize: 101 })).rejects.toThrow(CatalogValidationError)
  })
})

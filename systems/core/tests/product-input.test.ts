// tests/product-input.test.ts
import { describe, it, expect } from 'vitest'
import { parseProductInput, parseVariantInput, parseStockInput, slugify } from '../src/admin/product-input.js'

function fieldsOf(fn: () => unknown): Record<string, string> {
  try { fn() } catch (e: any) { expect(e.code).toBe('VALIDATION_ERROR'); return e.fields ?? {} }
  throw new Error('expected a VALIDATION_ERROR')
}

describe('slugify', () => {
  it('lowercases, hyphenates and trims', () => expect(slugify('  Deep Sea — Explorer!! ')).toBe('deep-sea-explorer'))
  it('caps at 80 without a trailing hyphen', () => {
    const s = slugify('a'.repeat(79) + ' b')
    expect(s.length).toBeLessThanOrEqual(80)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('parseProductInput create', () => {
  it('requires name and productType and derives the slug', () => {
    expect(parseProductInput({ name: 'Castle Set', productType: 'resale' }, 'create'))
      .toEqual({ name: 'Castle Set', productType: 'resale', slug: 'castle-set' })
  })
  it('reports every missing required field at once', () => {
    expect(Object.keys(fieldsOf(() => parseProductInput({}, 'create'))).sort()).toEqual(['name', 'productType'])
  })
  it('rejects a name with no letters or digits', () => {
    expect(fieldsOf(() => parseProductInput({ name: '!!!', productType: 'resale' }, 'create'))).toHaveProperty('name')
  })
})

describe('parseProductInput patch', () => {
  it('accepts a partial body', () => {
    expect(parseProductInput({ pieces: 1200 }, 'patch')).toEqual({ pieces: 1200 })
  })
  it('rejects unknown and read-only keys', () => {
    const f = fieldsOf(() => parseProductInput({ nmae: 'x', status: 'published', firstPublishedAt: null }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(['firstPublishedAt', 'nmae', 'status'])
  })
  it('validates every rule in spec §4.1', () => {
    const f = fieldsOf(() => parseProductInput({
      slug: 'Bad Slug', releaseType: 'x', pieces: 0, difficulty: 'hard', homePosition: 1.5,
      categories: ['OK tag'], features: [''], ageRecommendation: 'x'.repeat(21), description: 'x'.repeat(501),
    }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(
      ['ageRecommendation', 'categories', 'description', 'difficulty', 'features', 'homePosition', 'pieces', 'releaseType', 'slug'])
  })
  it('allows clearing nullable fields', () => {
    expect(parseProductInput({ pieces: null, difficulty: null, dimensions: null }, 'patch'))
      .toEqual({ pieces: null, difficulty: null, dimensions: null })
  })
  it('lowercases and de-duplicates categories, trims list entries', () => {
    expect(parseProductInput({ categories: ['Star-Wars', 'star-wars'], features: [' Lights '] }, 'patch'))
      .toEqual({ categories: ['star-wars'], features: ['Lights'] })
  })
})

describe('parseVariantInput', () => {
  it('upper-cases the SKU and requires sku and price on create', () => {
    expect(parseVariantInput({ sku: 'abe-1001', priceCents: 1999, onHand: 3 }, 'create'))
      .toEqual({ sku: 'ABE-1001', priceCents: 1999, onHand: 3 })
    expect(Object.keys(fieldsOf(() => parseVariantInput({}, 'create'))).sort()).toEqual(['priceCents', 'sku'])
  })
  it('enforces price > 0, USD only, attribute limits, no onHand on patch', () => {
    const f = fieldsOf(() => parseVariantInput({ priceCents: 0, currency: 'EUR', attributes: { '': 'x' }, onHand: 1 }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(['attributes', 'currency', 'onHand', 'priceCents'])
  })
  it('prefixes field names for bulk rows', () => {
    expect(fieldsOf(() => parseVariantInput({ sku: '', priceCents: 1 }, 'create', 'variants.2.'))).toHaveProperty('variants.2.sku')
  })
})

describe('parseStockInput', () => {
  it('distinguishes "not sent" from "shared" for allocation', () => {
    expect(parseStockInput({ onHand: 3 })).toEqual({ onHand: 3, allocationProvided: false, walmartAllocation: null })
    expect(parseStockInput({ walmartAllocation: null })).toEqual({ allocationProvided: true, walmartAllocation: null })
    expect(parseStockInput({ walmartAllocation: 1, expectedOnHand: 1, note: 'lot 7' }))
      .toEqual({ allocationProvided: true, walmartAllocation: 1, expectedOnHand: 1, note: 'lot 7' })
  })
  it('requires at least one of onHand / walmartAllocation, and valid integers', () => {
    expect(fieldsOf(() => parseStockInput({}))).toHaveProperty('onHand')
    expect(Object.keys(fieldsOf(() => parseStockInput({ onHand: -1, walmartAllocation: 1.5, note: 'x'.repeat(501) }))).sort())
      .toEqual(['note', 'onHand', 'walmartAllocation'])
  })
})

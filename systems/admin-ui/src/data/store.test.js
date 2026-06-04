import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from './store.js'

let store
beforeEach(() => { store = createStore() })

describe('store products', () => {
  it('seeds two products', () => {
    expect(store.listAll()).toHaveLength(2)
  })
  it('creates a product with generated id, slug, draft status, summary counts', () => {
    const p = store.create({ name: 'New Thing', description: 'd', categories: [], metadata: {} })
    expect(p.id).toMatch(/^prod-/)
    expect(p.slug).toBe('new-thing')
    expect(p.status).toBe('draft')
    expect(store.get(p.id).name).toBe('New Thing')
  })
  it('rejects create without a name (VALIDATION_ERROR)', () => {
    expect(() => store.create({ name: '' })).toThrowError(/name/i)
  })
  it('ensures unique slug on create', () => {
    const a = store.create({ name: 'Dup' })
    const b = store.create({ name: 'Dup' })
    expect(b.slug).toBe(`${a.slug}-2`)
  })
  it('updates fields and bumps updated_at', () => {
    const before = store.get('prod-002').updated_at
    const p = store.update('prod-002', { description: 'now has text' }, '2026-06-04T00:00:00.000Z')
    expect(p.description).toBe('now has text')
    expect(p.updated_at).not.toBe(before)
  })
  it('archive sets status archived and archived_at', () => {
    const p = store.setStatus('prod-001', 'archived', '2026-06-04T00:00:00.000Z')
    expect(p.status).toBe('archived')
    expect(p.archived_at).toBe('2026-06-04T00:00:00.000Z')
  })
  it('publish sets published_at', () => {
    const p = store.setStatus('prod-002', 'published', '2026-06-04T00:00:00.000Z')
    expect(p.status).toBe('published')
    expect(p.published_at).toBe('2026-06-04T00:00:00.000Z')
  })
})

describe('store variants', () => {
  it('adds a variant and rejects duplicate SKU', () => {
    const v = store.addVariant('prod-002', { sku: 'SR-A', price: 9.99, attributes: {} })
    expect(v.id).toMatch(/^var-/)
    expect(() => store.addVariant('prod-002', { sku: 'SR-A', price: 1 })).toThrowError(/sku/i)
  })
  it('deletes a variant', () => {
    store.addVariant('prod-002', { sku: 'SR-B', price: 1 })
    const v = store.addVariant('prod-002', { sku: 'SR-C', price: 1 })
    store.deleteVariant('prod-002', v.id)
    expect(store.get('prod-002').variants.some(x => x.id === v.id)).toBe(false)
  })
})

describe('store images', () => {
  it('adds image with incrementing display_order and reorders', () => {
    const i1 = store.addImage('prod-002', { url: 'u1', alt_text: 'a' })
    const i2 = store.addImage('prod-002', { url: 'u2', alt_text: 'b' })
    expect(i1.display_order).toBe(0)
    expect(i2.display_order).toBe(1)
    store.reorderImages('prod-002', [i2.id, i1.id])
    const imgs = store.get('prod-002').images
    expect(imgs.find(x => x.id === i2.id).display_order).toBe(0)
  })
})

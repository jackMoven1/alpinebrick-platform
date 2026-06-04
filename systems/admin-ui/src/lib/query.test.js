import { describe, it, expect } from 'vitest'
import { applyQuery } from './query.js'

const rows = [
  { id: 'a', name: 'Alpha', status: 'published', categories: ['x'], updated_at: '2026-01-03' },
  { id: 'b', name: 'Bravo', status: 'draft',     categories: ['y'], updated_at: '2026-01-02' },
  { id: 'c', name: 'Charlie', status: 'published', categories: ['x'], updated_at: '2026-01-01' },
]

describe('applyQuery', () => {
  it('returns all rows with envelope when no opts', () => {
    const r = applyQuery(rows, {})
    expect(r.total).toBe(3)
    expect(r.items).toHaveLength(3)
    expect(r.page).toBe(1)
  })
  it('filters by case-insensitive name search', () => {
    expect(applyQuery(rows, { search: 'brav' }).items.map(i => i.id)).toEqual(['b'])
  })
  it('filters by status and category', () => {
    expect(applyQuery(rows, { status: 'published' }).total).toBe(2)
    expect(applyQuery(rows, { category: 'y' }).items.map(i => i.id)).toEqual(['b'])
  })
  it('sorts by name_desc and updated_desc', () => {
    expect(applyQuery(rows, { sort: 'name_desc' }).items.map(i => i.id)).toEqual(['c', 'b', 'a'])
    expect(applyQuery(rows, { sort: 'updated_desc' }).items.map(i => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('paginates and reports true total', () => {
    const r = applyQuery(rows, { page: 2, limit: 2, sort: 'name_asc' })
    expect(r.total).toBe(3)
    expect(r.items.map(i => i.id)).toEqual(['c'])
  })
})

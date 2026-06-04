import { describe, it, expect } from 'vitest'
import { slugify, ensureUniqueSlug } from './slug.js'

describe('slugify', () => {
  it('lowercases, trims, and hyphenates', () => {
    expect(slugify('  Classic Brick Set ')).toBe('classic-brick-set')
  })
  it('strips non-alphanumerics and collapses separators', () => {
    expect(slugify('Red & Blue!! 100pc')).toBe('red-blue-100pc')
  })
  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('')
  })
})

describe('ensureUniqueSlug', () => {
  it('returns the base slug when unused', () => {
    expect(ensureUniqueSlug('abc', [])).toBe('abc')
  })
  it('suffixes -2, -3 when taken', () => {
    expect(ensureUniqueSlug('abc', ['abc'])).toBe('abc-2')
    expect(ensureUniqueSlug('abc', ['abc', 'abc-2'])).toBe('abc-3')
  })
})

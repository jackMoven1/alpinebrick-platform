import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { imageUrl } from '../src/assets/image-url.js'

const KEY = 'products/p1/i1/original.jpg'
let saved: string | undefined

beforeEach(() => {
  saved = process.env.ASSET_PUBLIC_BASE_URL
  process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test'
})
afterEach(() => { process.env.ASSET_PUBLIC_BASE_URL = saved })

describe('imageUrl', () => {
  it('returns the original when no options are given', () => {
    expect(imageUrl(KEY)).toBe('https://cdn.test/products/p1/i1/original.jpg')
  })

  it('adds a width parameter', () => {
    expect(imageUrl(KEY, { width: 800 })).toBe('https://cdn.test/products/p1/i1/original.jpg?w=800')
  })

  it('adds width and format together', () => {
    expect(imageUrl(KEY, { width: 800, format: 'webp' }))
      .toBe('https://cdn.test/products/p1/i1/original.jpg?w=800&fmt=webp')
  })

  it('does not double a slash when the base has a trailing one', () => {
    process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test/'
    expect(imageUrl(KEY)).toBe('https://cdn.test/products/p1/i1/original.jpg')
  })

  it('rejects a non-positive width rather than emitting a nonsense URL', () => {
    expect(() => imageUrl(KEY, { width: 0 })).toThrow()
    expect(() => imageUrl(KEY, { width: -100 })).toThrow()
  })
})

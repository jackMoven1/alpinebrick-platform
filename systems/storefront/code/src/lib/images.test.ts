import { describe, it, expect } from 'vitest'
import { imageUrl, imageSrcSet, CARD_WIDTHS, DETAIL_WIDTHS } from './images'

const KEY = 'products/p1/i1/original.jpg'

describe('imageUrl', () => {
  it('returns the original when no options are given', () => {
    expect(imageUrl(KEY)).toBe('/products/p1/i1/original.jpg')
  })

  it('adds a width parameter', () => {
    expect(imageUrl(KEY, { width: 800 })).toBe('/products/p1/i1/original.jpg?w=800')
  })

  it('adds width and format together, in that order', () => {
    expect(imageUrl(KEY, { width: 800, format: 'webp' }))
      .toBe('/products/p1/i1/original.jpg?w=800&fmt=webp')
  })

  it('rejects a non-positive width rather than emitting a nonsense URL', () => {
    expect(() => imageUrl(KEY, { width: 0 })).toThrow()
    expect(() => imageUrl(KEY, { width: -100 })).toThrow()
  })

  // Storage keys are relative by contract. A doubled separator produced a
  // 404 in the browser while every unit test still passed.
  it('never produces a doubled slash', () => {
    expect(imageUrl('img/placeholder/skyline-1.svg')).toBe('/img/placeholder/skyline-1.svg')
    expect(imageUrl(KEY, { width: 400 })).not.toContain('//')
  })
})

describe('imageSrcSet', () => {
  it('emits one candidate per width with its descriptor', () => {
    expect(imageSrcSet(KEY, [400, 800])).toBe(
      '/products/p1/i1/original.jpg?w=400 400w, /products/p1/i1/original.jpg?w=800 800w',
    )
  })

  it('exposes ascending width ladders for cards and detail', () => {
    expect([...CARD_WIDTHS].sort((a, b) => a - b)).toEqual([...CARD_WIDTHS])
    expect([...DETAIL_WIDTHS].sort((a, b) => a - b)).toEqual([...DETAIL_WIDTHS])
  })
})

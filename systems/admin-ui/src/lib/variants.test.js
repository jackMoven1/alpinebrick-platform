import { describe, it, expect } from 'vitest'
import { generateVariants } from './variants.js'

describe('generateVariants', () => {
  it('creates one variant per value with prefixed SKU and shared price', () => {
    const out = generateVariants({ sku_prefix: 'CBS-', price: 29.99, attribute_key: 'size', values: ['S', 'M', 'L'] })
    expect(out).toEqual([
      { sku: 'CBS-S', price: 29.99, attributes: { size: 'S' } },
      { sku: 'CBS-M', price: 29.99, attributes: { size: 'M' } },
      { sku: 'CBS-L', price: 29.99, attributes: { size: 'L' } },
    ])
  })
  it('uppercases value in SKU and trims whitespace values', () => {
    const out = generateVariants({ sku_prefix: 'X-', price: 1, attribute_key: 'color', values: [' red '] })
    expect(out[0].sku).toBe('X-RED')
    expect(out[0].attributes).toEqual({ color: 'red' })
  })
  it('skips empty values', () => {
    const out = generateVariants({ sku_prefix: 'X-', price: 1, attribute_key: 'size', values: ['S', '', '  '] })
    expect(out).toHaveLength(1)
  })
})

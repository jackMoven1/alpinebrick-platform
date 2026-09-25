import { describe, it, expect } from 'vitest'
import { errorText } from './errorText.js'
import { AdminApiError } from '../data/errors.js'

describe('errorText', () => {
  it('returns the message alone when there are no fields', () => {
    expect(errorText(new AdminApiError('product not found', 'NOT_FOUND'))).toBe('product not found')
  })

  it('follows the message with field hints, naming bulk rows 1-based', () => {
    const err = new AdminApiError('invalid input', 'VALIDATION_ERROR', {
      'variants.3.sku': 'already in use', 'variants.0.priceCents': 'at least 1', 'variants.1.onHand': 'a whole number',
      'variants.2.attributes': 'text values only',
    })
    expect(errorText(err)).toBe(
      'invalid input (Row 4 SKU: already in use; Row 1 price: at least 1; Row 2 quantity: a whole number; Row 3 attributes: text values only)')
  })

  it('labels top-level fields', () => {
    expect(errorText(new AdminApiError('invalid input', 'VALIDATION_ERROR', { sku: 'already in use' })))
      .toBe('invalid input (SKU: already in use)')
  })

  it('falls back when there is no message', () => {
    expect(errorText(new Error(''))).toBe('Request failed')
  })
})

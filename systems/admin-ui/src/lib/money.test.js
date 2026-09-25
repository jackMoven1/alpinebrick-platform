import { describe, it, expect } from 'vitest'
import { dollarsToCents, formatCents } from './money.js'

describe('money', () => {
  it('parses dollars exactly, without float drift', () => {
    expect(dollarsToCents('189')).toBe(18900)
    expect(dollarsToCents('19.99')).toBe(1999)
    expect(dollarsToCents('0.29')).toBe(29)
    expect(dollarsToCents('$1,234.5')).toBe(123450)
  })
  it('rejects anything that is not a price', () => {
    expect(dollarsToCents('')).toBeNull()
    expect(dollarsToCents('1.234')).toBeNull()
    expect(dollarsToCents('abc')).toBeNull()
  })
  it('formats cents as USD', () => expect(formatCents(18900)).toBe('$189.00'))
})

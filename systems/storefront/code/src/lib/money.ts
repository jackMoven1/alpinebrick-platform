import type { Product } from './api/types'

const FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Cents in, display string out. This is the ONLY place cents become dollars.
 * Everything upstream — API, cart, order lines — stays in integer cents.
 */
export function formatCents(cents: number): string {
  return FORMATTER.format(cents / 100)
}

/** The cheapest variant's price, or null when a product has no variants. */
export function minPriceCents(p: Product): number | null {
  if (!p.variants || p.variants.length === 0) return null
  return Math.min(...p.variants.map(v => v.priceCents))
}

/**
 * Cents to the decimal string the Square Web Payments SDK takes
 * (`11593` -> `'115.93'`). Integer arithmetic, so no float rounding.
 */
export function centsToDecimal(cents: number): string {
  const whole = Math.floor(cents / 100)
  const part = String(cents % 100).padStart(2, '0')
  return `${whole}.${part}`
}

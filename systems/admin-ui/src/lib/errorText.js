/**
 * One way to turn a failed admin request into text. Core's message says what
 * went wrong and what to do; field hints ("at least 2") only make sense after
 * it, so they follow in brackets. Bulk keys like `variants.3.sku` name the
 * 1-based row the operator sees ("Row 4 SKU").
 */
const LABELS = {
  sku: 'SKU', priceCents: 'price', onHand: 'quantity', attributes: 'attributes',
  walmartAllocation: 'Walmart allocation', expectedOnHand: 'expected on hand', note: 'note',
}

const label = (key, labels) => {
  const m = /^variants\.(\d+)\.(.+)$/.exec(key)
  if (m) return `Row ${Number(m[1]) + 1} ${labels[m[2]] ?? m[2]}`
  return labels[key] ?? key
}

/** `overrides` renames fields for a screen whose label differs (e.g. "On hand"). */
export function errorText(err, overrides = {}) {
  const labels = { ...LABELS, ...overrides }
  const message = err?.message || 'Request failed'
  const hints = Object.entries(err?.fields ?? {}).map(([k, hint]) => `${label(k, labels)}: ${hint}`)
  return hints.length ? `${message} (${hints.join('; ')})` : message
}

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

const label = (key) => {
  const m = /^variants\.(\d+)\.(.+)$/.exec(key)
  if (m) return `Row ${Number(m[1]) + 1} ${LABELS[m[2]] ?? m[2]}`
  return LABELS[key] ?? key
}

export function errorText(err) {
  const message = err?.message || 'Request failed'
  const hints = Object.entries(err?.fields ?? {}).map(([k, hint]) => `${label(k)}: ${hint}`)
  return hints.length ? `${message} (${hints.join('; ')})` : message
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "19.99" -> 1999. String arithmetic, so 0.29 never becomes 28. null if not a price. */
export function dollarsToCents(text) {
  const s = String(text ?? '').trim().replace(/[$,\s]/g, '')
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

export function formatCents(cents) {
  return USD.format((cents ?? 0) / 100)
}

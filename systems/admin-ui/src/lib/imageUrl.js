/**
 * Composes a delivery URL from an immutable storage key.
 *
 * The console renders images that core returns as keys, so it needs the same
 * grammar the storefront and core use. Kept deliberately minimal — the console
 * only ever needs a thumbnail.
 *
 * Storage keys are relative and never start with a slash, so joining is always
 * `${BASE}/${key}` and never produces a doubled separator.
 */
const BASE = (import.meta.env?.VITE_ASSET_BASE_URL ?? '').replace(/\/+$/, '')

export function imageUrlFromKey(storageKey, width) {
  if (!storageKey) return ''
  const qs = width ? `?w=${width}` : ''
  return `${BASE}/${storageKey}${qs}`
}

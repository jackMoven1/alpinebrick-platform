export type ImageFormat = 'auto' | 'webp' | 'jpeg'

export interface ImageUrlOptions {
  width?: number
  format?: ImageFormat
}

/** Ascending ladders. Keep sorted — imageSrcSet emits them in order. */
export const CARD_WIDTHS = [400, 600, 900] as const
export const DETAIL_WIDTHS = [600, 900, 1400, 2000] as const

const BASE = (import.meta.env.VITE_ASSET_BASE_URL ?? '/assets').replace(/\/+$/, '')

/**
 * Composes a delivery URL from an immutable storage key.
 *
 * THIS FUNCTION IS DUPLICATED in core (systems/core/src/assets/image-url.ts)
 * and the two must produce identical output — core needs it for the Walmart
 * item feed, this copy serves srcset, and the two packages cannot import each
 * other. resolver-parity.test.ts fails if the grammars drift.
 *
 * Changing CDN provider means changing this grammar in both places and one
 * environment variable. No database rows change.
 */
export function imageUrl(storageKey: string, opts: ImageUrlOptions = {}): string {
  const params = new URLSearchParams()

  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 1) {
      throw new Error(`imageUrl: width must be a positive integer, got ${opts.width}`)
    }
    params.set('w', String(opts.width))
  }
  if (opts.format) params.set('fmt', opts.format)

  const qs = params.toString()
  return `${BASE}/${storageKey}${qs ? `?${qs}` : ''}`
}

export function imageSrcSet(storageKey: string, widths: readonly number[]): string {
  return widths.map(w => `${imageUrl(storageKey, { width: w })} ${w}w`).join(', ')
}

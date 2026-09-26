export type ImageFormat = 'auto' | 'webp' | 'jpeg'

export interface ImageUrlOptions {
  width?: number
  format?: ImageFormat
}

/** Ascending ladders. Keep sorted — imageSrcSet emits them in order. */
export const CARD_WIDTHS = [400, 600, 900] as const
export const DETAIL_WIDTHS = [600, 900, 1400, 2000] as const

/**
 * VITE_ASSET_BASE_URL is the imgix domain for each environment (ADR-0002),
 * set per static site at build time. It is empty in local dev, where keys
 * resolve against the storefront's own origin -- which is where the
 * placeholder art in public/ is served from.
 *
 * Storage keys are relative and never start with a slash, so joining is always
 * `${BASE}/${key}` and never produces a doubled separator.
 */
const BASE = (import.meta.env.VITE_ASSET_BASE_URL ?? '').replace(/\/+$/, '')

/**
 * Composes a delivery URL from an immutable storage key.
 *
 * THIS FUNCTION IS DUPLICATED in core (systems/core/src/assets/image-url.ts)
 * and the two must produce identical output — core needs it for the Walmart
 * item feed, this copy serves srcset, and the two packages cannot import each
 * other. resolver-parity.test.ts fails if the grammars drift.
 *
 * The grammar is imgix's (ADR-0002, decided 2026-09-25). Changing provider
 * means changing it here, in the other copy, and the base-URL environment
 * variable. No database rows change.
 */

/** imgix parameter for each supported format (spec 2026-09-25 §4.3). */
const FORMAT_PARAM: Record<ImageFormat, [string, string]> = {
  auto: ['auto', 'format'],
  webp: ['fm', 'webp'],
  jpeg: ['fm', 'jpg'],
}

export function imageUrl(storageKey: string, opts: ImageUrlOptions = {}): string {
  const params = new URLSearchParams()

  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 1) {
      throw new Error(`imageUrl: width must be a positive integer, got ${opts.width}`)
    }
    params.set('w', String(opts.width))
  }
  if (opts.format) {
    const [name, value] = FORMAT_PARAM[opts.format]
    params.set(name, value)
  }

  const qs = params.toString()
  return `${BASE}/${storageKey}${qs ? `?${qs}` : ''}`
}

export function imageSrcSet(storageKey: string, widths: readonly number[]): string {
  return widths.map(w => `${imageUrl(storageKey, { width: w })} ${w}w`).join(', ')
}

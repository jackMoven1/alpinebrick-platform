export type ImageFormat = 'auto' | 'webp' | 'jpeg'

export interface ImageUrlOptions {
  width?: number
  format?: ImageFormat
}

/**
 * Composes a delivery URL from an immutable storage key.
 *
 * THIS FUNCTION IS DUPLICATED in the storefront
 * (systems/storefront/code/src/lib/images.ts) and the two must produce
 * identical output. Core needs it for the Walmart item feed; the storefront
 * copy serves srcset. A parity test in the storefront pins them together.
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
  const base = (process.env.ASSET_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
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
  return `${base}/${storageKey}${qs ? `?${qs}` : ''}`
}

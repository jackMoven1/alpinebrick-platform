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
 * Changing CDN provider means changing this grammar in both places and the
 * ASSET_PUBLIC_BASE_URL environment variable. No database rows change.
 */
export function imageUrl(storageKey: string, opts: ImageUrlOptions = {}): string {
  const base = (process.env.ASSET_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  const params = new URLSearchParams()

  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 1) {
      throw new Error(`imageUrl: width must be a positive integer, got ${opts.width}`)
    }
    params.set('w', String(opts.width))
  }
  if (opts.format) params.set('fmt', opts.format)

  const qs = params.toString()
  return `${base}/${storageKey}${qs ? `?${qs}` : ''}`
}

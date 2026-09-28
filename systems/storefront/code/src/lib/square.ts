import type { Square } from '@square/web-payments-sdk-types'

export interface SquareConfig { applicationId: string; locationId: string; environment: 'sandbox' | 'production' }

/** Square requires the SDK to load from its own CDN (plan header). */
export const SQUARE_SCRIPT_URLS = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
} as const

/**
 * The three build-time settings (spec §4 Storefront). null when any is
 * missing: the cart then refuses to start checkout, because a checkout that
 * cannot show the payment form would only reserve stock for nothing.
 */
export function squareConfig(): SquareConfig | null {
  const applicationId = import.meta.env.VITE_SQUARE_APPLICATION_ID as string | undefined
  const locationId = import.meta.env.VITE_SQUARE_LOCATION_ID as string | undefined
  const environment = import.meta.env.VITE_SQUARE_ENVIRONMENT as string | undefined
  if (!applicationId || !locationId || (environment !== 'sandbox' && environment !== 'production')) return null
  return { applicationId, locationId, environment }
}

let promise: Promise<Square | null> | null = null

/**
 * Injects Square's script once and resolves `window.Square`. A failed load
 * (blocked script, network) resolves to null for the page's load-failed
 * view, and is not remembered: the next call tries again.
 */
export function loadSquare(): Promise<Square | null> | null {
  const config = squareConfig()
  if (!config) return null
  if (!promise) {
    promise = new Promise<Square | null>((resolve) => {
      if (window.Square) {
        resolve(window.Square)
        return
      }
      const script = document.createElement('script')
      script.src = SQUARE_SCRIPT_URLS[config.environment]
      script.async = true
      script.dataset.squareSdk = ''
      script.onload = () => {
        // Loaded but no SDK (e.g. a proxy's error page): drop the tag so a retry reinjects it.
        if (!window.Square) script.remove()
        resolve(window.Square ?? null)
      }
      script.onerror = () => {
        script.remove()
        resolve(null)
      }
      document.head.appendChild(script)
    }).then((square) => {
      if (!square) promise = null
      return square
    })
  }
  return promise
}

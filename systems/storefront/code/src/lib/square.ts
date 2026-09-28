import type { Square } from '@square/web-payments-sdk-types'

export interface SquareConfig { applicationId: string; locationId: string; environment: 'sandbox' | 'production' }

/** Square requires the SDK to load from its own CDN (plan header). */
export const SQUARE_SCRIPT_URLS = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
} as const

/** How long loadSquare waits for Square's script before treating it as failed. */
export const SQUARE_LOAD_TIMEOUT_MS = 15_000

let warned = false

/**
 * The three build-time settings (spec §4 Storefront). null when any is
 * missing: the cart then refuses to start checkout, because a checkout that
 * cannot show the payment form would only reserve stock for nothing.
 * The environment is trimmed and lower-cased; a value that is set but is
 * neither sandbox nor production is a misconfigured build, warned about once.
 */
export function squareConfig(): SquareConfig | null {
  const applicationId = import.meta.env.VITE_SQUARE_APPLICATION_ID as string | undefined
  const locationId = import.meta.env.VITE_SQUARE_LOCATION_ID as string | undefined
  const raw = import.meta.env.VITE_SQUARE_ENVIRONMENT as string | undefined
  const environment = raw?.trim().toLowerCase()
  if (environment && environment !== 'sandbox' && environment !== 'production' && !warned) {
    warned = true
    console.warn(`VITE_SQUARE_ENVIRONMENT must be "sandbox" or "production"; got "${raw}". Checkout is off.`)
  }
  if (!applicationId || !locationId || (environment !== 'sandbox' && environment !== 'production')) return null
  return { applicationId, locationId, environment }
}

let promise: Promise<Square | null> | null = null

/**
 * Injects Square's script once and resolves `window.Square`. A failed load
 * (blocked script, network, or no answer within SQUARE_LOAD_TIMEOUT_MS)
 * resolves to null for the page's load-failed view, drops the tag, and is
 * not remembered: the next call tries again.
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
      const finish = (square: Square | null) => {
        clearTimeout(timer)
        script.onload = null
        script.onerror = null
        // No SDK (a failure, a timeout, or a proxy's error page): drop the tag so a retry reinjects it.
        if (!square) script.remove()
        resolve(square)
      }
      const timer = setTimeout(() => finish(null), SQUARE_LOAD_TIMEOUT_MS)
      script.onload = () => finish(window.Square ?? null)
      script.onerror = () => finish(null)
      document.head.appendChild(script)
    }).then((square) => {
      if (!square) promise = null
      return square
    })
  }
  return promise
}

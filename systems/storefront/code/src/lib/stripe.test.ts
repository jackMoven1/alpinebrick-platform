import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn() }))
import { loadStripe } from '@stripe/stripe-js'

// Not key-shaped on purpose: no Stripe key, real or fake, lives in the repo.
const KEY = 'publishable-key-for-tests'

/** stripe.ts memoises at module level, so each test gets a fresh copy. */
async function freshGetStripe() {
  vi.resetModules()
  return (await import('./stripe')).getStripe
}

beforeEach(() => { vi.mocked(loadStripe).mockReset() })
afterEach(() => { vi.unstubAllEnvs() })

describe('getStripe', () => {
  it('returns null when this build has no publishable key', async () => {
    vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', '')
    const getStripe = await freshGetStripe()
    expect(getStripe()).toBeNull()
    expect(loadStripe).not.toHaveBeenCalled()
  })

  it('loads Stripe.js once and reuses it', async () => {
    vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', KEY)
    const stripe = {} as never
    vi.mocked(loadStripe).mockResolvedValue(stripe)
    const getStripe = await freshGetStripe()
    expect(await getStripe()).toBe(stripe)
    expect(await getStripe()).toBe(stripe)
    expect(loadStripe).toHaveBeenCalledTimes(1)
  })

  // A blocked js.stripe.com must land on the page's load-failed view, not
  // surface as an unhandled rejection -- and must not be remembered forever.
  it('turns a failed load into null and retries on the next call', async () => {
    vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', KEY)
    const stripe = {} as never
    vi.mocked(loadStripe)
      .mockRejectedValueOnce(new Error('Failed to load Stripe.js'))
      .mockResolvedValueOnce(stripe)
    const getStripe = await freshGetStripe()
    await expect(getStripe()).resolves.toBeNull()
    expect(await getStripe()).toBe(stripe)
    expect(loadStripe).toHaveBeenCalledTimes(2)
  })
})

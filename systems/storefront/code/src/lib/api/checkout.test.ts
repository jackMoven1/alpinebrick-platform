import { describe, it, expect, vi, afterEach } from 'vitest'
import { startCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE } from './checkout'

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const REQ = { lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: false, referral: null }

describe('checkout client', () => {
  it('POSTs JSON without credentials and returns the secret', async () => {
    const spy = stubFetch(201, { orderId: 'o1', clientSecret: 'cs_1_secret' })
    expect(await startCheckout(REQ)).toEqual({ orderId: 'o1', clientSecret: 'cs_1_secret' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/api/v1/checkout')).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual(REQ)
  })

  it('maps stock errors with their lines', async () => {
    stubFetch(409, { code: 'insufficient_stock', message: 'm', details: { lines: [{ variantId: 'v1', code: 'insufficient_stock', available: 1 }] } })
    const err = await startCheckout(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err.code).toBe('insufficient_stock')
    expect(err.lines).toEqual([{ variantId: 'v1', code: 'insufficient_stock', available: 1 }])
  })

  it('turns unknown codes, bad bodies and network failures into checkout_unavailable', async () => {
    stubFetch(500, { code: 'INTERNAL_ERROR' })
    expect(await startCheckout(REQ).catch((e) => e)).toMatchObject({ code: 'checkout_unavailable', message: UNAVAILABLE_MESSAGE })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    expect(await startCheckout(REQ).catch((e) => e)).toMatchObject({ code: 'checkout_unavailable' })
  })

  it('explains the rate limit', async () => {
    stubFetch(429, { code: 'rate_limited', message: 'x' })
    expect((await startCheckout(REQ).catch((e) => e)).message).toMatch(/wait a minute/)
  })

  it('reads the status for a session id, encoded', async () => {
    const spy = stubFetch(200, { status: 'paid' })
    await getCheckoutStatus('cs_test_a b')
    expect(String(spy.mock.calls[0][0])).toContain('/api/v1/checkout/status?session_id=cs_test_a%20b')
  })

  it('maps not_found to its own error kind, not a temporary error', async () => {
    stubFetch(404, { code: 'not_found', message: 'no such order' })
    const err = await getCheckoutStatus('cs_missing').catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err.code).toBe('not_found')
  })
})

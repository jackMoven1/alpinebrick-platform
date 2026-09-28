import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  startCheckout, quoteCheckout, payCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE,
} from './checkout'

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const REQ = { lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: false, referral: null }
const QUOTE_REQ = { email: 'a@example.com', name: 'Ann', address: { line1: '1 Main St', line2: '', city: 'Traverse City', state: 'MI', postalCode: '49684' } }

describe('checkout client', () => {
  it('POSTs the cart without credentials and returns the order id', async () => {
    const spy = stubFetch(201, { orderId: 'o1' })
    expect(await startCheckout(REQ)).toEqual({ orderId: 'o1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/api/v1/checkout')).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual(REQ)
  })

  it('quotes and pays against the order id, encoded', async () => {
    const spy = stubFetch(200, { quoteVersion: 1, subtotalCents: 1, shippingCents: 0, taxCents: 0, totalCents: 1 })
    await quoteCheckout('o 1', QUOTE_REQ)
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/v1\/checkout\/o%201\/quote$/)
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual(QUOTE_REQ)
    const pay = stubFetch(200, { status: 'processing' })
    expect(await payCheckout('o1', { sourceToken: 'tok', quoteVersion: 1 })).toEqual({ status: 'processing' })
    expect(String(pay.mock.calls[0][0])).toMatch(/\/api\/v1\/checkout\/o1\/pay$/)
  })

  it('reads the status by order id', async () => {
    const spy = stubFetch(200, { status: 'paid' })
    await getCheckoutStatus('o 1')
    expect(String(spy.mock.calls[0][0])).toContain('/api/v1/checkout/status?orderId=o%201')
  })

  it('maps stock errors with their lines', async () => {
    stubFetch(409, { code: 'insufficient_stock', message: 'm', details: { lines: [{ variantId: 'v1', code: 'insufficient_stock', available: 1 }] } })
    const err = await startCheckout(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err.lines).toEqual([{ variantId: 'v1', code: 'insufficient_stock', available: 1 }])
  })

  it.each([
    [422, 'outside_shipping_area', 'We ship to the contiguous US only.'],
    [409, 'quote_changed', 'Your total has changed. Check it and pay again.'],
    [409, 'order_expired', 'This checkout expired.'],
    [402, 'payment_declined', 'Your card was declined — try another card.'],
    [409, 'payment_pending', "We're still confirming an earlier payment attempt for this order."],
    [429, 'too_many_attempts', 'Too many payment attempts for this order. Start again from your cart.'],
  ])('keeps core’s code and message for %i %s', async (status, code, message) => {
    stubFetch(status, { code, message })
    expect(await payCheckout('o1', { sourceToken: 't', quoteVersion: 1 }).catch((e) => e)).toMatchObject({ code, message })
  })

  it('carries the invalid field', async () => {
    stubFetch(400, { code: 'invalid_request', message: 'a 5-digit ZIP code', details: { field: 'address.postalCode' } })
    expect(await quoteCheckout('o1', QUOTE_REQ).catch((e) => e)).toMatchObject({ code: 'invalid_request', field: 'address.postalCode' })
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

  it('maps not_found to its own error kind', async () => {
    stubFetch(404, { code: 'not_found', message: 'no such order' })
    expect((await getCheckoutStatus('missing').catch((e) => e)).code).toBe('not_found')
  })
})

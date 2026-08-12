import { describe, it, expect } from 'vitest'
import { createWalmartClient, WalmartApiError } from '../src/channels/walmart/client.js'

function stubFetch(script: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const next = script.shift() ?? { status: 500, body: 'exhausted' }
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

const token = { access_token: 'tok-1', expires_in: 900 }

describe('walmart client', () => {
  it('fetches a token once and sends auth headers', async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 200, body: token },
      { status: 200, body: { ok: 1 } },
      { status: 200, body: { ok: 2 } },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    await c.request('GET', '/v3/orders', { query: { limit: '10' } })
    await c.request('GET', '/v3/orders')
    expect(calls[0].url).toBe('https://sandbox.test/v3/token')
    expect(calls[1].url).toBe('https://sandbox.test/v3/orders?limit=10')
    const h = calls[1].init.headers as Record<string, string>
    expect(h['WM_SEC.ACCESS_TOKEN']).toBe('tok-1')
    expect(h['WM_SVC.NAME']).toBe('AlpineBricks')
    expect(h['WM_QOS.CORRELATION_ID']).toBeTruthy()
    expect(calls.length).toBe(3) // token reused for second call
  })

  it('retries 429 then succeeds', async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 200, body: token },
      { status: 429, body: 'slow down', headers: { 'retry-after': '0' } },
      { status: 200, body: { ok: true } },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    const res = await c.request('GET', '/v3/inventory')
    expect(res).toEqual({ ok: true })
    expect(calls.length).toBe(3)
  })

  it('throws WalmartApiError after exhausting retries', async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: token },
      { status: 500, body: 'boom' }, { status: 500, body: 'boom' }, { status: 500, body: 'boom' },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    await expect(c.request('POST', '/v3/feeds', { body: { a: 1 } })).rejects.toBeInstanceOf(WalmartApiError)
  })
})

import { randomUUID } from 'node:crypto'

export class WalmartApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`walmart api error ${status}: ${body.slice(0, 500)}`)
    this.name = 'WalmartApiError'
  }
}

export interface WalmartClient {
  request(method: 'GET' | 'POST' | 'PUT', path: string, opts?: { body?: unknown; query?: Record<string, string> }): Promise<unknown>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createWalmartClient(cfg: { clientId?: string; clientSecret?: string; baseUrl?: string; fetchFn?: typeof fetch } = {}): WalmartClient {
  const clientId = cfg.clientId ?? process.env.WALMART_CLIENT_ID ?? ''
  const clientSecret = cfg.clientSecret ?? process.env.WALMART_CLIENT_SECRET ?? ''
  const baseUrl = (cfg.baseUrl ?? process.env.WALMART_API_BASE ?? 'https://sandbox.walmartapis.com').replace(/\/$/, '')
  const fetchFn = cfg.fetchFn ?? fetch
  let token: { value: string; expiresAt: number } | null = null

  async function getToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt > Date.now() + 60_000) return token.value
    const res = await fetchFn(`${baseUrl}/v3/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'WM_QOS.CORRELATION_ID': randomUUID(),
        // Registered identifier Walmart knows us by -- see the plan's Task 2 note.
        // Plural, deliberately not the internal `AlpineBrick` convention.
        'WM_SVC.NAME': 'AlpineBricks',
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) throw new WalmartApiError(res.status, await res.text())
    const data = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
    return token.value
  }

  async function request(method: 'GET' | 'POST' | 'PUT', path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
    let refreshed = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetchFn(`${baseUrl}${path}${qs}`, {
        method,
        headers: {
          'WM_SEC.ACCESS_TOKEN': await getToken(),
          'WM_QOS.CORRELATION_ID': randomUUID(),
          'WM_SVC.NAME': 'AlpineBricks',
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
      if (res.ok) {
        const text = await res.text()
        return text ? JSON.parse(text) : null
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await getToken(true)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : attempt * 500)
        continue
      }
      throw new WalmartApiError(res.status, await res.text())
    }
    throw new WalmartApiError(0, 'unreachable')
  }

  return { request }
}

let singleton: WalmartClient | null = null
export function getWalmartClient(): WalmartClient {
  if (!singleton) singleton = createWalmartClient()
  return singleton
}

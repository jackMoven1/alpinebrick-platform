import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import { AdminApiError } from './errors.js'

function mockFetch(status, body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status < 400, status, json: async () => body,
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('listProducts', () => {
  it('sends only the parameters supplied', async () => {
    const spy = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    }))
    vi.stubGlobal('fetch', spy)
    await api.listProducts({ status: 'draft', page: 2 })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('status=draft')
    expect(url).toContain('page=2')
    expect(url).not.toContain('search=')
  })

  // The console says `limit`; core says `pageSize`.
  it('maps the console limit onto core pageSize', async () => {
    const spy = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 25 }),
    }))
    vi.stubGlobal('fetch', spy)
    await api.listProducts({ limit: 25 })
    expect(String(spy.mock.calls[0][0])).toContain('pageSize=25')
  })

  it('returns the envelope unchanged, in camelCase', async () => {
    mockFetch(200, {
      items: [{
        id: 'p1', slug: 's', name: 'N', status: 'draft', categories: [],
        variantCount: 1, imageCount: 0, updatedAt: '2026-08-13T00:00:00Z',
      }],
      total: 1, page: 1, pageSize: 20,
    })
    const r = await api.listProducts({})
    expect(r.total).toBe(1)
    expect(r.items[0].variantCount).toBe(1)
  })
})

describe('error handling', () => {
  it('throws AdminApiError carrying the server code', async () => {
    mockFetch(400, { code: 'VALIDATION_ERROR', message: 'bad status' })
    await expect(api.listProducts({})).rejects.toMatchObject({
      name: 'AdminApiError', code: 'VALIDATION_ERROR', message: 'bad status',
    })
  })

  it('surfaces an illegal transition as INVALID_TRANSITION', async () => {
    mockFetch(409, { code: 'INVALID_TRANSITION', message: 'cannot move from archived to published' })
    const err = await api.setProductStatus('p1', 'published').catch(e => e)
    expect(err).toBeInstanceOf(AdminApiError)
    expect(err.code).toBe('INVALID_TRANSITION')
  })

  // A network failure has no envelope; it must still be branchable on .code.
  it('synthesises INTERNAL when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await api.getOverviewStats().catch(e => e)
    expect(err.code).toBe('INTERNAL')
  })
})

describe('unimplemented methods', () => {
  it('exposes every method mockApi does', () => {
    const expected = [
      'getOverviewStats', 'listProducts', 'getProduct', 'createProduct', 'updateProduct',
      'archiveProduct', 'setProductStatus', 'bulkSetStatus', 'createVariant', 'updateVariant',
      'deleteVariant', 'bulkCreateVariants', 'addImage', 'reorderImages', 'updateImageAlt', 'deleteImage',
    ]
    for (const m of expected) expect(typeof api[m]).toBe('function')
  })

  // Falling back to the mock would show edits succeeding and losing them on
  // reload. Throwing is the safe failure.
  it('throws rather than silently succeeding', async () => {
    await expect(api.createProduct({ name: 'x' })).rejects.toThrow(/not implemented/i)
    await expect(api.createVariant('p1', {})).rejects.toThrow(/not implemented/i)
    await expect(api.updateProduct('p1', {})).rejects.toThrow(/not implemented/i)
    await expect(api.bulkSetStatus(['p1'], 'draft')).rejects.toThrow(/not implemented/i)
  })
})

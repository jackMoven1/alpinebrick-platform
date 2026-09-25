import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import product from './__fixtures__/product.json'
import stockChanged from './__fixtures__/stock-changed.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('write methods hit core, never the mock', () => {
  it.each([
    ['createProduct', () => api.createProduct({ name: 'X', productType: 'resale' }), 'POST', '/api/v1/admin/products'],
    ['updateProduct', () => api.updateProduct('p1', { name: 'Y' }), 'PATCH', '/api/v1/admin/products/p1'],
    ['bulkSetStatus', () => api.bulkSetStatus(['a'], 'published'), 'POST', '/api/v1/admin/products/bulk-status'],
    ['createVariant', () => api.createVariant('p1', { sku: 'A', priceCents: 1 }), 'POST', '/api/v1/admin/products/p1/variants'],
    ['bulkCreateVariants', () => api.bulkCreateVariants('p1', [{ sku: 'A', priceCents: 1 }]), 'POST', '/api/v1/admin/products/p1/variants/bulk'],
    ['updateVariant', () => api.updateVariant('v1', { priceCents: 2 }), 'PATCH', '/api/v1/admin/variants/v1'],
    ['deleteVariant', () => api.deleteVariant('v1'), 'DELETE', '/api/v1/admin/variants/v1'],
    ['setStock', () => api.setStock('v1', { onHand: 3 }), 'PUT', '/api/v1/admin/variants/v1/stock'],
    ['getStockHistory', () => api.getStockHistory('v1'), 'GET', '/api/v1/admin/variants/v1/stock-history?limit=10'],
  ])('%s', async (_name, invoke, method, path) => {
    const spy = spyFetch(200, product)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(path)).toBe(true)
    expect(init.method ?? 'GET').toBe(method)
    expect(init.credentials).toBe('include')
  })

  it('wraps bulk variants in { variants }', async () => {
    const spy = spyFetch(201, product)
    await api.bulkCreateVariants('p1', [{ sku: 'A', priceCents: 1 }])
    expect(JSON.parse(call(spy).init.body)).toEqual({ variants: [{ sku: 'A', priceCents: 1 }] })
  })
})

describe('errors keep details', () => {
  it('exposes code, fields and details from core', async () => {
    spyFetch(409, stockChanged)
    await expect(api.setStock('v1', { onHand: 5, expectedOnHand: 99 }))
      .rejects.toMatchObject({ code: 'STOCK_CHANGED', details: stockChanged.details })
  })
})

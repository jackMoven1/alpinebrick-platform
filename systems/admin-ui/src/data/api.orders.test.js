import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import queue from './__fixtures__/order-queue.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())
const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('order and settings methods hit core', () => {
  it.each([
    ['listOrders', () => api.listOrders({ tab: 'to_ship', page: 2 }), 'GET', '/api/v1/admin/orders?tab=to_ship&page=2&pageSize=25'],
    ['getOrder', () => api.getOrder('o 1'), 'GET', '/api/v1/admin/orders/o%201'],
    ['shipOrder', () => api.shipOrder('o1', { carrier: 'USPS', trackingNumber: '9400' }), 'POST', '/api/v1/admin/orders/o1/ship'],
    ['cancelOrder', () => api.cancelOrder('o1'), 'POST', '/api/v1/admin/orders/o1/cancel'],
    ['getShippingSettings', () => api.getShippingSettings(), 'GET', '/api/v1/admin/settings/shipping'],
    ['updateShippingSettings', () => api.updateShippingSettings({ flatRateCents: 995, freeThresholdCents: null }), 'PUT', '/api/v1/admin/settings/shipping'],
  ])('%s', async (_name, invoke, method, path) => {
    const spy = spyFetch(200, queue)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(path)).toBe(true)
    expect(init.method ?? 'GET').toBe(method)
    expect(init.credentials).toBe('include')
  })

  it('sends the ship form as JSON', async () => {
    const spy = spyFetch(200, {})
    await api.shipOrder('o1', { carrier: 'Other', acknowledgeReview: true })
    expect(JSON.parse(call(spy).init.body)).toEqual({ carrier: 'Other', acknowledgeReview: true })
  })

  it('sends acknowledgeReview on cancel when provided', async () => {
    const spy = spyFetch(200, {})
    await api.cancelOrder('o1', { acknowledgeReview: true })
    expect(JSON.parse(call(spy).init.body)).toEqual({ acknowledgeReview: true })
  })

  it('sends an empty body on cancel when no options are given', async () => {
    const spy = spyFetch(200, {})
    await api.cancelOrder('o1')
    expect(JSON.parse(call(spy).init.body)).toEqual({})
  })
})

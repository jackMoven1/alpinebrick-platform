// src/data/api.images.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import token from './__fixtures__/image-upload-token.json'
import confirmed from './__fixtures__/image-confirmed.json'
import rejected from './__fixtures__/image-rejected.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())
const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('image methods hit core', () => {
  it('requests an upload slot with the file type and size', async () => {
    const spy = spyFetch(201, token)
    const file = new File([new Uint8Array(70)], 'a.png', { type: 'image/png' })
    expect(await api.requestImageUpload('p1', file)).toEqual(token)
    const { url, init } = call(spy)
    expect(url.endsWith('/api/v1/admin/images/upload-token')).toBe(true)
    expect(JSON.parse(init.body)).toEqual({ productId: 'p1', contentType: 'image/png', byteSize: 70 })
  })
  it.each([
    ['confirmImage', () => api.confirmImage('i1'), 'POST', '/images/i1/confirm'],
    ['reorderImages', () => api.reorderImages('p1', ['a', 'b']), 'PUT', '/images/reorder'],
    ['updateImageAlt', () => api.updateImageAlt('i1', 'Front'), 'PATCH', '/images/i1'],
    ['deleteImage', () => api.deleteImage('i1'), 'DELETE', '/images/i1'],
  ])('%s', async (_n, invoke, method, path) => {
    const spy = spyFetch(200, confirmed)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(`/api/v1/admin${path}`)).toBe(true)
    expect(init.method).toBe(method)
  })
  it('surfaces core\'s lower_snake image error with its message', async () => {
    spyFetch(409, rejected)
    await expect(api.confirmImage('i1')).rejects.toMatchObject({ code: rejected.code, message: rejected.message })
  })
})

describe('uploadToStorage', () => {
  function fakeXhr(status) {
    const x = {
      upload: {}, headers: {}, withCredentials: undefined,
      open: vi.fn(), setRequestHeader: vi.fn((k, v) => { x.headers[k] = v }),
      send: vi.fn(() => { x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }); x.status = status; x.onload() }),
    }
    vi.stubGlobal('XMLHttpRequest', vi.fn(() => x))
    return x
  }
  it('PUTs the file with its content type, no credentials, reporting progress', async () => {
    const x = fakeXhr(200)
    const progress = vi.fn()
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await api.uploadToStorage('https://s3.test/k?sig', file, progress)
    expect(x.open).toHaveBeenCalledWith('PUT', 'https://s3.test/k?sig')
    expect(x.headers['Content-Type']).toBe('image/jpeg')
    expect(x.withCredentials).toBe(false)
    expect(progress).toHaveBeenCalledWith(0.5)
  })
  it('rejects on a non-2xx from storage', async () => {
    fakeXhr(403)
    await expect(api.uploadToStorage('u', new File(['x'], 'a.jpg', { type: 'image/jpeg' })))
      .rejects.toMatchObject({ code: 'UPLOAD_FAILED' })
  })
})

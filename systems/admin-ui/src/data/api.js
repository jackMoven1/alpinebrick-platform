import { AdminApiError } from './errors.js'
import { API_BASE_URL } from '../lib/apiBase.js'

// NOTE the argument order. The console's AdminApiError is
// (message, code, fields) — message FIRST. Core's AdminError is
// (code, message) — code first. They are different classes in different
// packages and the orders are opposite, which is easy to get backwards and
// produces an error whose code reads like a sentence.
//
// BASE is absolute once VITE_API_BASE_URL is set, relative (unchanged)
// otherwise -- see lib/apiBase.js. Cross-origin (the console's real
// deployment, spec §6.1), a relative path resolves against the console's
// own static host, which serves neither this nor /api/v1/auth.
const BASE = `${API_BASE_URL}/api/v1/admin`
const GENERIC = 'Something went wrong. Please try again.'

/**
 * Every failure leaves here as an AdminApiError with a usable `code`, so the
 * console can branch on it. Network and parse failures carry no server
 * envelope, so they are given INTERNAL.
 */
async function call(path, options = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...options,
    })
  } catch {
    throw new AdminApiError(GENERIC, 'INTERNAL')
  }

  if (res.status === 401) {
    // Not an error the UI should render -- the session is gone or was never
    // there, and the only useful response is to send the admin to sign in.
    // assign() does not unload the page synchronously, so if this threw (or
    // resolved), the caller's own .then/.catch would still run in the same
    // tick and render "authentication required" before navigation completes.
    // Returning a promise that never settles leaves every caller sitting in
    // its loading state instead, which is correct: the page is on its way
    // out. Land on /signin, not the OAuth route directly -- the console
    // explains why the session ended before bouncing to a third party, and
    // an automatic bounce straight to Google can loop invisibly if anything
    // upstream is wrong.
    window.location.assign('/signin')
    return new Promise(() => {})
  }

  if (!res.ok) {
    let body
    try { body = await res.json() } catch { throw new AdminApiError(GENERIC, 'INTERNAL') }
    throw new AdminApiError(body?.message || GENERIC, body?.code || 'INTERNAL', body?.fields, body?.details)
  }

  if (res.status === 204) return null
  try { return await res.json() } catch { throw new AdminApiError(GENERIC, 'INTERNAL') }
}

/**
 * Only the four image methods remain unbacked (ADR-0002).
 *
 * These MUST throw rather than fall back to the mock. A mock fallback would
 * show an edit succeeding and lose it on reload — data loss disguised as
 * success. The UI also disables the affected controls, so this throw is a
 * developer-facing backstop, not the user-facing message.
 */
function notImplemented(name) {
  return async () => {
    throw new AdminApiError(
      `${name} is not implemented in the Phase B slice`,
      'NOT_IMPLEMENTED',
    )
  }
}

export const api = {
  async getOverviewStats() {
    return call('/overview')
  },

  async listProducts(opts = {}) {
    const params = new URLSearchParams()
    if (opts.status) params.set('status', opts.status)
    if (opts.search) params.set('search', opts.search)
    if (opts.page) params.set('page', String(opts.page))
    // The console calls it `limit`; core calls it `pageSize`.
    if (opts.limit) params.set('pageSize', String(opts.limit))
    const qs = params.toString()
    return call(`/products${qs ? `?${qs}` : ''}`)
  },

  async getProduct(id) {
    return call(`/products/${encodeURIComponent(id)}`)
  },

  async setProductStatus(id, status) {
    return call(`/products/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  },

  async archiveProduct(id) {
    return api.setProductStatus(id, 'archived')
  },

  async createProduct(input) {
    return call('/products', { method: 'POST', body: JSON.stringify(input) })
  },
  async updateProduct(id, patch) {
    return call(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async bulkSetStatus(ids, status) {
    return call('/products/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) })
  },
  async createVariant(productId, input) {
    return call(`/products/${encodeURIComponent(productId)}/variants`, { method: 'POST', body: JSON.stringify(input) })
  },
  async bulkCreateVariants(productId, variants) {
    return call(`/products/${encodeURIComponent(productId)}/variants/bulk`, { method: 'POST', body: JSON.stringify({ variants }) })
  },
  async updateVariant(variantId, patch) {
    return call(`/variants/${encodeURIComponent(variantId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async deleteVariant(variantId) {
    return call(`/variants/${encodeURIComponent(variantId)}`, { method: 'DELETE', body: '{}' })
  },
  async setStock(variantId, input) {
    return call(`/variants/${encodeURIComponent(variantId)}/stock`, { method: 'PUT', body: JSON.stringify(input) })
  },
  async getStockHistory(variantId, limit = 10) {
    return call(`/variants/${encodeURIComponent(variantId)}/stock-history?limit=${limit}`)
  },

  addImage: notImplemented('addImage'),
  reorderImages: notImplemented('reorderImages'),
  updateImageAlt: notImplemented('updateImageAlt'),
  deleteImage: notImplemented('deleteImage'),
}

export default api

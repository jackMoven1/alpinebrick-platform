import axios from 'axios'

// In development: requests go through Vite proxy to Express on localhost:3000
// In production: requests go through Express on localhost:3000 which proxies
// to the catalog-service at /api/v1/catalog (ADR-0001).
const API_BASE = '/'

// v1 default page size per ADR-0001.
const DEFAULT_LIMIT = 24

// Sort values frozen by ADR-0001.
const VALID_SORTS = ['name_asc', 'price_asc', 'price_desc', 'newest']

const catalogClient = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
})

// Normalize the catalog API error envelope { code, message, fields? } into an
// Error the UI can branch on. `code` is stable: NOT_FOUND, VALIDATION_ERROR,
// INTERNAL. Network/timeout failures get a synthetic INTERNAL code.
function toCatalogError(error, fallbackMessage) {
  const body = error?.response?.data
  const code = body?.code || 'INTERNAL'
  const message = body?.message || fallbackMessage
  const err = new Error(message)
  err.code = code
  if (body?.fields) err.fields = body.fields
  return err
}

export const catalogService = {
  // Fetch a page of products. Server owns pagination/filter/sort/search; we
  // pass params through and consume the { items, total, page, limit } envelope
  // directly (no client-side slicing).
  async getProducts(options = {}) {
    const {
      search,
      category,
      page = 1,
      limit = DEFAULT_LIMIT,
      sort = 'name_asc',
    } = options

    const params = new URLSearchParams()
    params.append('page', String(page))
    params.append('limit', String(limit))
    if (search) params.append('search', search)
    if (category) params.append('category', category)
    if (sort && VALID_SORTS.includes(sort)) params.append('sort', sort)

    try {
      const response = await catalogClient.get(`catalog/products?${params.toString()}`)

      // Envelope is the source of truth: { items, total, page, limit }.
      const { items = [], total = 0, page: respPage, limit: respLimit } = response.data || {}
      const effectiveLimit = respLimit ?? limit
      return {
        products: items,
        total,
        page: respPage ?? page,
        limit: effectiveLimit,
        totalPages: effectiveLimit > 0 ? Math.ceil(total / effectiveLimit) : 0,
      }
    } catch (error) {
      console.error('Failed to fetch products:', error)
      throw toCatalogError(error, 'Failed to load products. Please try again.')
    }
  },

  // Fetch single product by ID
  async getProduct(id) {
    try {
      const response = await catalogClient.get(`catalog/products/${id}`)
      return response.data
    } catch (error) {
      console.error(`Failed to fetch product ${id}:`, error)
      throw toCatalogError(error, 'Failed to load product. Please try again.')
    }
  },

  // Fetch product availability
  async getProductAvailability(id) {
    try {
      const response = await catalogClient.get(`catalog/products/${id}/availability`)
      return response.data
    } catch (error) {
      console.error(`Failed to fetch availability for ${id}:`, error)
      throw toCatalogError(error, 'Failed to load product availability.')
    }
  },
}

export default catalogService

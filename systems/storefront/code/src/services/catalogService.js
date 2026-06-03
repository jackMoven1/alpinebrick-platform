import axios from 'axios'

// In development: requests go through Vite proxy to Express on localhost:3000
// In production: requests go through Express on localhost:3000 which proxies to catalog-service
const API_BASE = '/'

const catalogClient = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
})

export const catalogService = {
  // Fetch all products with optional filters
  async getProducts(options = {}) {
    const { search, category, page = 1, limit = 20 } = options
    
    const params = new URLSearchParams()
    if (search) params.append('search', search)
    if (category) params.append('category', category)
    
    try {
      const response = await catalogClient.get(`catalog/products?${params.toString()}`)
      
      // API returns array, convert to paginated format
      const allProducts = response.data
      const startIndex = (page - 1) * limit
      const endIndex = startIndex + limit
      const paginatedProducts = allProducts.slice(startIndex, endIndex)
      
      return {
        products: paginatedProducts,
        total: allProducts.length,
        page,
        limit,
        totalPages: Math.ceil(allProducts.length / limit),
      }
    } catch (error) {
      console.error('Failed to fetch products:', error)
      throw new Error('Failed to load products. Please try again.')
    }
  },

  // Fetch single product by ID
  async getProduct(id) {
    try {
      const response = await catalogClient.get(`catalog/products/${id}`)
      return response.data
    } catch (error) {
      console.error(`Failed to fetch product ${id}:`, error)
      throw new Error('Failed to load product. Please try again.')
    }
  },

  // Fetch product availability
  async getProductAvailability(id) {
    try {
      const response = await catalogClient.get(`catalog/products/${id}/availability`)
      return response.data
    } catch (error) {
      console.error(`Failed to fetch availability for ${id}:`, error)
      throw new Error('Failed to load product availability.')
    }
  },
}

export default catalogService

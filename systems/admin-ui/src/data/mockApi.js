import { createStore } from './store.js'
import { applyQuery } from '../lib/query.js'
import { generateVariants } from '../lib/variants.js'

const store = createStore() // single in-session instance

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const summarize = (p) => ({
  id: p.id, name: p.name, status: p.status, categories: p.categories,
  variant_count: p.variants.length, image_count: p.images.length, updated_at: p.updated_at,
})

export const mockApi = {
  async getOverviewStats() {
    await delay()
    const all = store.listAll()
    const summaries = all.map(summarize)
    return {
      totalProducts: all.length,
      published: all.filter((p) => p.status === 'published').length,
      draft: all.filter((p) => p.status === 'draft').length,
      archived: all.filter((p) => p.status === 'archived').length,
      recentlyModified: [...summaries].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 5),
      missingImages: summaries.filter((p) => p.image_count === 0 && p.status !== 'archived'),
      missingVariants: summaries.filter((p) => p.variant_count === 0 && p.status !== 'archived'),
    }
  },
  async listProducts(opts = {}) {
    await delay()
    return applyQuery(store.listAll().map(summarize), opts)
  },
  async getProduct(id) { await delay(); return store.get(id) },
  async createProduct(input) { await delay(); return store.create(input) },
  async updateProduct(id, patch) { await delay(); return store.update(id, patch) },
  async archiveProduct(id) { await delay(); return store.setStatus(id, 'archived') },
  async setProductStatus(id, status) { await delay(); return store.setStatus(id, status) },
  async bulkSetStatus(ids, status) {
    await delay()
    ids.forEach((id) => store.setStatus(id, status))
    return { updated: ids.length }
  },
  async createVariant(productId, input) { await delay(); return store.addVariant(productId, input) },
  async updateVariant(productId, variantId, patch) { await delay(); return store.updateVariant(productId, variantId, patch) },
  async deleteVariant(productId, variantId) { await delay(); return store.deleteVariant(productId, variantId) },
  async bulkCreateVariants(productId, template) {
    await delay()
    const created = generateVariants(template).map((v) => store.addVariant(productId, v))
    return { created }
  },
  async addImage(productId, input) { await delay(); return store.addImage(productId, input) },
  async reorderImages(productId, orderedIds) { await delay(); return store.reorderImages(productId, orderedIds) },
  async updateImageAlt(productId, imageId, alt_text) { await delay(); return store.updateImageAlt(productId, imageId, alt_text) },
  async deleteImage(productId, imageId) { await delay(); return store.deleteImage(productId, imageId) },
}

export default mockApi

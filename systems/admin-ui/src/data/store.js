import { makeSeed } from './seed.js'
import { slugify, ensureUniqueSlug } from '../lib/slug.js'
import { AdminApiError } from './errors.js'

export function createStore() {
  let products = makeSeed()
  let seq = { prod: 100, var: 100, img: 100 }
  const nextId = (kind) => `${kind}-${String(++seq[kind]).padStart(3, '0')}`
  const now = () => new Date().toISOString() // overridable via explicit arg in mutators for tests

  const find = (id) => products.find((p) => p.id === id)
  const require = (id) => {
    const p = find(id)
    if (!p) throw new AdminApiError(`Product ${id} not found`, 'NOT_FOUND')
    return p
  }

  return {
    listAll: () => products.map((p) => JSON.parse(JSON.stringify(p))),
    get: (id) => {
      const p = require(id)
      return JSON.parse(JSON.stringify(p))
    },
    create: (input, ts) => {
      const name = (input?.name || '').trim()
      if (!name) throw new AdminApiError('Name is required', 'VALIDATION_ERROR', { name: 'required' })
      const base = slugify(input.slug || name)
      const slug = ensureUniqueSlug(base, products.map((p) => p.slug))
      const stamp = ts || now()
      const p = {
        id: nextId('prod'), name, slug,
        description: input.description || '', categories: input.categories || [],
        metadata: input.metadata || {}, status: 'draft',
        published_at: null, archived_at: null,
        created_at: stamp, updated_at: stamp, created_by: 'admin-1', updated_by: 'admin-1',
        variants: [], images: [],
      }
      products.push(p)
      return JSON.parse(JSON.stringify(p))
    },
    update: (id, patch, ts) => {
      const p = require(id)
      const allowed = ['name', 'description', 'categories', 'metadata', 'slug']
      for (const k of allowed) if (k in patch) p[k] = patch[k]
      p.updated_at = ts || now()
      p.updated_by = 'admin-1'
      return JSON.parse(JSON.stringify(p))
    },
    setStatus: (id, status, ts) => {
      const p = require(id)
      if (!['draft', 'published', 'archived'].includes(status))
        throw new AdminApiError('Invalid status', 'VALIDATION_ERROR')
      p.status = status
      const stamp = ts || now()
      if (status === 'published') p.published_at = stamp
      if (status === 'archived') p.archived_at = stamp
      p.updated_at = stamp
      return JSON.parse(JSON.stringify(p))
    },
    addVariant: (productId, input) => {
      const p = require(productId)
      const sku = (input?.sku || '').trim()
      if (!sku) throw new AdminApiError('SKU is required', 'VALIDATION_ERROR', { sku: 'required' })
      if (p.variants.some((v) => v.sku === sku))
        throw new AdminApiError(`SKU ${sku} already exists`, 'VALIDATION_ERROR', { sku: 'duplicate' })
      const v = { id: nextId('var'), product_id: productId, sku, price: Number(input.price) || 0,
        inventory_item_id: input.inventory_item_id || null, attributes: input.attributes || {} }
      p.variants.push(v)
      return { ...v }
    },
    updateVariant: (productId, variantId, patch) => {
      const p = require(productId)
      const v = p.variants.find((x) => x.id === variantId)
      if (!v) throw new AdminApiError('Variant not found', 'NOT_FOUND')
      if (patch.sku && patch.sku !== v.sku && p.variants.some((x) => x.sku === patch.sku))
        throw new AdminApiError(`SKU ${patch.sku} already exists`, 'VALIDATION_ERROR', { sku: 'duplicate' })
      Object.assign(v, { ...patch, price: patch.price != null ? Number(patch.price) : v.price })
      return { ...v }
    },
    deleteVariant: (productId, variantId) => {
      const p = require(productId)
      p.variants = p.variants.filter((v) => v.id !== variantId)
      return { success: true }
    },
    addImage: (productId, input) => {
      const p = require(productId)
      const img = { id: nextId('img'), product_id: productId, url: input.url,
        alt_text: input.alt_text || '', display_order: p.images.length }
      p.images.push(img)
      return { ...img }
    },
    reorderImages: (productId, orderedIds) => {
      const p = require(productId)
      const byId = new Map(p.images.map((i) => [i.id, i]))
      p.images = orderedIds.map((id, idx) => ({ ...byId.get(id), display_order: idx }))
      return { images: p.images.map((i) => ({ ...i })) }
    },
    updateImageAlt: (productId, imageId, alt_text) => {
      const p = require(productId)
      const img = p.images.find((i) => i.id === imageId)
      if (!img) throw new AdminApiError('Image not found', 'NOT_FOUND')
      img.alt_text = alt_text
      return { ...img }
    },
    deleteImage: (productId, imageId) => {
      const p = require(productId)
      p.images = p.images.filter((i) => i.id !== imageId)
      return { success: true }
    },
  }
}

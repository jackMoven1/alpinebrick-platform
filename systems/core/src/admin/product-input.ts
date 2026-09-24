import { AdminError } from './admin-errors.js'

type Fields = Record<string, string>
type Obj = Record<string, unknown>

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SKU_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
const PRODUCT_TYPES = ['own_designed', 'resale'] as const
const RELEASE_TYPES = ['standard', 'limited_run', 'specialty'] as const
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const

export type ProductData = {
  name?: string; slug?: string
  productType?: (typeof PRODUCT_TYPES)[number]; releaseType?: (typeof RELEASE_TYPES)[number]
  description?: string; longDescription?: string; builderNotes?: string
  categories?: string[]; features?: string[]; includes?: string[]
  pieces?: number | null; difficulty?: (typeof DIFFICULTIES)[number] | null
  ageRecommendation?: string | null; dimensions?: string | null
  homePosition?: number | null; collectionPosition?: number | null
}
export type VariantData = { sku?: string; priceCents?: number; attributes?: Record<string, string>; onHand?: number }
export type StockData = {
  onHand?: number; allocationProvided: boolean; walmartAllocation: number | null
  expectedOnHand?: number; note?: string
}

const PRODUCT_KEYS = [
  'name', 'slug', 'productType', 'releaseType', 'description', 'longDescription', 'builderNotes',
  'categories', 'features', 'includes', 'pieces', 'difficulty', 'ageRecommendation', 'dimensions',
  'homePosition', 'collectionPosition',
]

export function slugify(input: string): string {
  return String(input).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '')
}

function asObject(body: unknown): Obj {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  }
  return body as Obj
}
function done(fields: Fields) {
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function text(b: Obj, key: string, max: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (typeof v !== 'string' || v.length > max) f[key] = `text, at most ${max} characters`
  else out[key] = v
}
function nullableText(b: Obj, key: string, max: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (v === null || v === '') { out[key] = null; return }
  if (typeof v !== 'string' || v.trim().length > max) f[key] = `text, at most ${max} characters, or empty`
  else out[key] = v.trim()
}
function nullableInt(b: Obj, key: string, min: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (v === null) { out[key] = null; return }
  if (!isInt(v) || v < min) f[key] = `a whole number of at least ${min}, or empty`
  else out[key] = v
}
function oneOf(b: Obj, key: string, allowed: readonly string[], nullable: boolean, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (nullable && v === null) { out[key] = null; return }
  if (typeof v !== 'string' || !allowed.includes(v)) f[key] = `one of: ${allowed.join(', ')}`
  else out[key] = v
}
function list(b: Obj, key: string, maxItems: number, maxLen: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (!Array.isArray(v) || v.length > maxItems) { f[key] = `a list of at most ${maxItems} entries`; return }
  const items = v.map((x) => (typeof x === 'string' ? x.trim() : ''))
  if (items.some((x) => x.length < 1 || x.length > maxLen)) { f[key] = `each entry 1–${maxLen} characters`; return }
  out[key] = items
}

export function parseProductInput(body: unknown, mode: 'create' | 'patch'): ProductData {
  const b = asObject(body)
  const f: Fields = {}
  const out: Obj = {}

  for (const k of Object.keys(b)) if (!PRODUCT_KEYS.includes(k)) f[k] = 'unknown or read-only field'

  if ('name' in b || mode === 'create') {
    const v = b.name
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > 200) f.name = 'required, 1–200 characters'
    else out.name = v.trim()
  }
  if ('slug' in b) {
    const v = b.slug
    if (typeof v !== 'string' || v.length > 80 || !SLUG_RE.test(v)) {
      f.slug = 'lowercase letters, numbers and single hyphens, at most 80 characters'
    } else out.slug = v
  }
  if ('productType' in b || mode === 'create') oneOf({ productType: b.productType }, 'productType', PRODUCT_TYPES, false, out, f)
  oneOf(b, 'releaseType', RELEASE_TYPES, false, out, f)
  oneOf(b, 'difficulty', DIFFICULTIES, true, out, f)
  text(b, 'description', 500, out, f)
  text(b, 'longDescription', 10_000, out, f)
  text(b, 'builderNotes', 5_000, out, f)
  nullableText(b, 'ageRecommendation', 20, out, f)
  nullableText(b, 'dimensions', 100, out, f)
  nullableInt(b, 'pieces', 1, out, f)
  nullableInt(b, 'homePosition', 1, out, f)
  nullableInt(b, 'collectionPosition', 1, out, f)
  list(b, 'features', 30, 200, out, f)
  list(b, 'includes', 30, 200, out, f)

  if ('categories' in b) {
    const v = b.categories
    const tags = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : null
    if (!tags || tags.length > 20 || tags.some((t) => !SLUG_RE.test(t))) {
      f.categories = 'at most 20 tags, each lowercase letters, numbers and hyphens'
    } else out.categories = [...new Set(tags)]
  }

  if (mode === 'create' && out.slug === undefined && typeof out.name === 'string') {
    const derived = slugify(out.name)
    if (!derived) f.name = 'must contain at least one letter or number'
    else out.slug = derived
  }

  done(f)
  return out as ProductData
}

const VARIANT_CREATE_KEYS = ['sku', 'priceCents', 'currency', 'attributes', 'onHand']
const VARIANT_PATCH_KEYS = ['sku', 'priceCents', 'currency', 'attributes']

export function parseVariantInput(body: unknown, mode: 'create' | 'patch', prefix = ''): VariantData {
  const b = asObject(body)
  const f: Fields = {}
  const out: VariantData = {}
  const allowed = mode === 'create' ? VARIANT_CREATE_KEYS : VARIANT_PATCH_KEYS

  for (const k of Object.keys(b)) if (!allowed.includes(k)) f[prefix + k] = 'unknown or read-only field'

  if ('sku' in b || mode === 'create') {
    const v = typeof b.sku === 'string' ? b.sku.trim().toUpperCase() : ''
    if (v.length < 1 || v.length > 64 || !SKU_RE.test(v)) {
      f[prefix + 'sku'] = 'capital letters, numbers and single hyphens, at most 64 characters'
    } else out.sku = v
  }
  if ('priceCents' in b || mode === 'create') {
    const v = b.priceCents
    if (!isInt(v) || v <= 0 || v > 100_000_000) f[prefix + 'priceCents'] = 'a price above $0'
    else out.priceCents = v
  }
  if ('currency' in b && b.currency !== 'USD') f[prefix + 'currency'] = 'USD only'
  if ('attributes' in b) {
    const v = b.attributes
    const ok = typeof v === 'object' && v !== null && !Array.isArray(v)
      && Object.keys(v).length <= 10
      && Object.entries(v as Obj).every(([k, x]) =>
        k.length >= 1 && k.length <= 40 && typeof x === 'string' && x.length >= 1 && x.length <= 100)
    if (!ok) f[prefix + 'attributes'] = 'up to 10 name/value pairs; names 1–40, values 1–100 characters'
    else out.attributes = v as Record<string, string>
  }
  if ('onHand' in b && mode === 'create') {
    if (!isInt(b.onHand) || (b.onHand as number) < 0) f[prefix + 'onHand'] = 'a whole number, 0 or more'
    else out.onHand = b.onHand as number
  }

  done(f)
  return out
}

const STOCK_KEYS = ['onHand', 'walmartAllocation', 'expectedOnHand', 'note']

export function parseStockInput(body: unknown): StockData {
  const b = asObject(body)
  const f: Fields = {}
  const out: StockData = { allocationProvided: false, walmartAllocation: null }

  for (const k of Object.keys(b)) if (!STOCK_KEYS.includes(k)) f[k] = 'unknown field'
  if (!('onHand' in b) && !('walmartAllocation' in b)) f.onHand = 'send onHand, walmartAllocation, or both'

  if ('onHand' in b) {
    if (!isInt(b.onHand) || (b.onHand as number) < 0) f.onHand = 'a whole number, 0 or more'
    else out.onHand = b.onHand as number
  }
  if ('walmartAllocation' in b) {
    out.allocationProvided = true
    const v = b.walmartAllocation
    if (v !== null && (!isInt(v) || (v as number) < 0)) f.walmartAllocation = 'a whole number, 0 or more, or null for shared'
    else out.walmartAllocation = v as number | null
  }
  if ('expectedOnHand' in b) {
    if (!isInt(b.expectedOnHand) || (b.expectedOnHand as number) < 0) f.expectedOnHand = 'a whole number, 0 or more'
    else out.expectedOnHand = b.expectedOnHand as number
  }
  if ('note' in b) {
    if (typeof b.note !== 'string' || b.note.length > 500) f.note = 'text, at most 500 characters'
    else out.note = b.note
  }

  done(f)
  return out
}

import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

export interface ProductImage { url: string; alt: string }

export interface ProductDto {
  id: string; slug: string; name: string; description: string
  productType: string; releaseType: string; status: string
  images: ProductImage[]
  categories: string[]
  pieces: number | null
  difficulty: string | null
  ageRecommendation: string | null
  dimensions: string | null
  longDescription: string
  features: string[]
  includes: string[]
  builderNotes: string
  homePosition: number | null
  collectionPosition: number | null
  createdAt: Date
  variants: { id: string; sku: string; priceCents: number; currency: string }[]
}

// `images` and `categories` are Json columns, so Postgres enforces nothing about
// their shape. Validate on read and drop anything malformed: a corrupt row must
// render without images rather than crash the grid.
export function toImages(v: unknown): ProductImage[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (i): i is ProductImage =>
      typeof i === 'object' && i !== null &&
      typeof (i as any).url === 'string' && typeof (i as any).alt === 'string',
  )
}

export function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

function toDto(p: any): ProductDto {
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    // Still the legacy JSON column. Task 5 switches this to the Image
    // relation; keeping it here leaves the build green in between.
    images: toImages(p.imagesJson),
    categories: toStringArray(p.categories),
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: toStringArray(p.features),
    includes: toStringArray(p.includes),
    builderNotes: p.builderNotes ?? '',
    homePosition: p.homePosition ?? null,
    collectionPosition: p.collectionPosition ?? null,
    createdAt: p.createdAt,
    variants: p.variants.map((v: any) => ({ id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency })),
  }
}

export type CatalogSort =
  | 'name_asc' | 'price_asc' | 'price_desc' | 'newest'
  | 'home_display' | 'collection_display'

export const VALID_SORTS: readonly CatalogSort[] = [
  'name_asc', 'price_asc', 'price_desc', 'newest',
  'home_display', 'collection_display',
]

export class CatalogValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

export async function listProducts(opts: {
  page?: number; pageSize?: number; search?: string
  category?: string; sort?: CatalogSort
  status?: 'published' | 'draft' | 'archived'
}) {
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const sort = opts.sort ?? 'name_asc'

  // Reject rather than clamp. A silently ignored bad parameter returns
  // plausible wrong results, which is harder to notice than an error.
  if (!Number.isInteger(page) || page < 1) {
    throw new CatalogValidationError('page', 'page must be an integer >= 1')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new CatalogValidationError('pageSize', 'pageSize must be an integer between 1 and 100')
  }
  if (!VALID_SORTS.includes(sort)) {
    throw new CatalogValidationError('sort', `sort must be one of: ${VALID_SORTS.join(', ')}`)
  }

  const status = opts.status ?? 'published'

  // Built as fragments so every value stays a bound parameter.
  const conds: Prisma.Sql[] = [Prisma.sql`p.status = ${status}::"ProductStatus"`]
  if (opts.search) {
    conds.push(Prisma.sql`p.name ILIKE ${'%' + opts.search + '%'}`)
  }
  if (opts.category) {
    conds.push(Prisma.sql`p.categories @> ${JSON.stringify([opts.category])}::jsonb`)
  }
  const where = Prisma.join(conds, ' AND ')

  // Raw SQL because ADR-0001 defines price sorting by a product's CHEAPEST
  // variant, and Prisma cannot orderBy a related-record aggregate other than
  // _count. Sorting in JS after fetching would sort only the current page.
  //
  // The two display sorts read merchandised position columns. NULLS LAST keeps
  // unranked products at the end rather than the top, and every branch ends
  // with `p.name ASC` so ties are deterministic — without it, two products
  // sharing a position can swap between pages and pagination becomes unstable.
  const orderBy =
    sort === 'price_asc' ? Prisma.sql`MIN(v.price_cents) ASC NULLS LAST, p.name ASC`
    : sort === 'price_desc' ? Prisma.sql`MIN(v.price_cents) DESC NULLS LAST, p.name ASC`
    : sort === 'newest' ? Prisma.sql`p.created_at DESC, p.name ASC`
    : sort === 'home_display' ? Prisma.sql`p.home_position ASC NULLS LAST, p.name ASC`
    : sort === 'collection_display' ? Prisma.sql`p.collection_position ASC NULLS LAST, p.name ASC`
    : Prisma.sql`p.name ASC`

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE ${where}
    GROUP BY p.id, p.name, p.created_at, p.home_position, p.collection_position
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `)

  const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM products p WHERE ${where}
  `)
  const total = Number(countRows[0]?.count ?? 0n)

  const ids = rows.map(r => r.id)
  if (ids.length === 0) return { items: [], total, page, pageSize }

  // findMany does not preserve the ordered ID list, so re-order explicitly.
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: { variants: true },
  })
  const byId = new Map(products.map(p => [p.id, p]))
  const items = ids.map(id => byId.get(id)).filter(Boolean).map(toDto)

  return { items, total, page, pageSize }
}

export async function getProduct(idOrSlug: string): Promise<ProductDto | null> {
  const p = await prisma.product.findFirst({
    where: { status: 'published', OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: true },
  })
  return p ? toDto(p) : null
}

export async function getAvailability(idOrSlug: string) {
  const p = await prisma.product.findFirst({
    where: { status: 'published', OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: { include: { inventory: true } } },
  })
  if (!p) return null
  return p.variants.map(v => ({
    variantId: v.id, sku: v.sku,
    available: (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0),
  }))
}

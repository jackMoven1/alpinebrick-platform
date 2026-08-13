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
    images: toImages(p.images),
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

export async function listProducts(opts: {
  page?: number; pageSize?: number; search?: string
  status?: 'published' | 'draft' | 'archived'
}) {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))
  const where: any = { status: opts.status ?? 'published' }
  if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, include: { variants: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.product.count({ where }),
  ])
  return { items: rows.map(toDto), total, page, pageSize }
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

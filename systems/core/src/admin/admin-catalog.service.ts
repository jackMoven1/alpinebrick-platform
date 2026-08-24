import { prisma } from '../prisma.js'
import type { ProductDto } from '../catalog/catalog.service.js'

export class AdminError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AdminError'
  }
}

export interface AdminProductSummary {
  id: string
  slug: string
  name: string
  status: string
  categories: string[]
  variantCount: number
  imageCount: number
  updatedAt: Date
}

const STATUSES = ['draft', 'published', 'archived'] as const
type Status = (typeof STATUSES)[number]

const SUMMARY_INCLUDE = { _count: { select: { variants: true, images: true } } } as const

function toSummary(r: any): AdminProductSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
    variantCount: r._count.variants,
    imageCount: r._count.images,
    updatedAt: r.updatedAt,
  }
}

/**
 * Admin list. Unlike the public list this returns EVERY status by default — an
 * admin console that cannot see drafts is useless. The public routes stay
 * published-only, which is why this is a separate surface rather than a flag
 * on the existing one.
 */
export async function adminListProducts(opts: {
  status?: string; search?: string; page?: number; pageSize?: number
}) {
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20

  if (!Number.isInteger(page) || page < 1) {
    throw new AdminError('VALIDATION_ERROR', 'page must be an integer >= 1')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new AdminError('VALIDATION_ERROR', 'pageSize must be an integer between 1 and 100')
  }
  if (opts.status !== undefined && !STATUSES.includes(opts.status as Status)) {
    throw new AdminError('VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`)
  }

  const where: any = {}
  if (opts.status) where.status = opts.status as Status
  if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' }

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: SUMMARY_INCLUDE,
    }),
    prisma.product.count({ where }),
  ])

  return { items: rows.map(toSummary), total, page, pageSize }
}

/** Admin detail. Loads a product in ANY status, including drafts. */
export async function adminGetProduct(id: string): Promise<ProductDto | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      variants: true,
      images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
    },
  })
  if (!p) return null
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    images: p.images.map(i => ({
      storageKey: i.storageKey, alt: i.alt, width: i.width, height: i.height, position: i.position,
    })),
    categories: Array.isArray(p.categories) ? (p.categories as string[]) : [],
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    includes: Array.isArray(p.includes) ? (p.includes as string[]) : [],
    builderNotes: p.builderNotes ?? '',
    homePosition: p.homePosition ?? null,
    collectionPosition: p.collectionPosition ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    variants: p.variants.map(v => ({
      id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency,
    })),
  }
}

/**
 * Legal status moves.
 *
 * archived -> published is deliberately absent: republishing something that was
 * withdrawn should be a considered act, so it must pass back through draft and
 * get a second look before facing customers again.
 *
 * A move to the status a product already has is also rejected — a no-op
 * transition is a client bug worth surfacing rather than absorbing.
 */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
}

export async function setProductStatus(id: string, target: string): Promise<ProductDto> {
  if (!STATUSES.includes(target as Status)) {
    throw new AdminError('VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`)
  }

  const existing = await prisma.product.findUnique({ where: { id } })
  if (!existing) throw new AdminError('NOT_FOUND', 'product not found')

  const allowed = ALLOWED_TRANSITIONS[existing.status] ?? []
  if (!allowed.includes(target)) {
    throw new AdminError(
      'INVALID_TRANSITION',
      `cannot move from ${existing.status} to ${target}; allowed: ${allowed.join(', ') || 'none'}`,
    )
  }

  await prisma.product.update({ where: { id }, data: { status: target as Status } })

  // Re-read through adminGetProduct so the response shape is identical to the
  // detail endpoint's; the console replaces its loaded product with this.
  const updated = await adminGetProduct(id)
  if (!updated) throw new AdminError('NOT_FOUND', 'product not found')
  return updated
}

export interface AdminOverview {
  totalProducts: number
  published: number
  draft: number
  archived: number
  recentlyModified: AdminProductSummary[]
  missingVariants: AdminProductSummary[]
}

/**
 * Console home counts.
 *
 * There is deliberately NO missingImages field. Every product currently has
 * placeholder images, so the check would render an all-clear while every
 * product is in fact missing real photography — technically correct and
 * practically a lie. It cannot be written honestly until placeholder and real
 * can be told apart.
 */
export async function getOverview(): Promise<AdminOverview> {
  const counts = await prisma.product.groupBy({ by: ['status'], _count: { _all: true } })
  const byStatus = Object.fromEntries(counts.map(c => [c.status, c._count._all]))

  const [recent, noVariants] = await Promise.all([
    prisma.product.findMany({
      orderBy: { updatedAt: 'desc' }, take: 5, include: SUMMARY_INCLUDE,
    }),
    prisma.product.findMany({
      where: { status: { not: 'archived' }, variants: { none: {} } },
      orderBy: { updatedAt: 'desc' },
      include: SUMMARY_INCLUDE,
    }),
  ])

  return {
    totalProducts: counts.reduce((n, c) => n + c._count._all, 0),
    published: byStatus.published ?? 0,
    draft: byStatus.draft ?? 0,
    archived: byStatus.archived ?? 0,
    recentlyModified: recent.map(toSummary),
    missingVariants: noVariants.map(toSummary),
  }
}

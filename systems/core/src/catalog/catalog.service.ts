import { prisma } from '../prisma.js'

export interface ProductDto {
  id: string; slug: string; name: string; description: string
  productType: string; releaseType: string; status: string
  variants: { id: string; sku: string; priceCents: number; currency: string }[]
}

function toDto(p: any): ProductDto {
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
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
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: true },
  })
  return p ? toDto(p) : null
}

export async function getAvailability(idOrSlug: string) {
  const p = await prisma.product.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: { include: { inventory: true } } },
  })
  if (!p) return null
  return p.variants.map(v => ({
    variantId: v.id, sku: v.sku,
    available: (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0),
  }))
}

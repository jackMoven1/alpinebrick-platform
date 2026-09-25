import { prisma } from '../prisma.js'
import type { ProductDto } from '../catalog/catalog.service.js'
import { storefrontSellable, walmartSellable } from '../inventory/allocation.js'

export interface AdminVariantDto {
  id: string; sku: string; priceCents: number; currency: string
  attributes: Record<string, string>
  inventory: { onHand: number; reserved: number; walmartAllocation: number | null; storefrontAvailable: number; walmartAvailable: number }
  locked: { sku: boolean; delete: boolean }
}

export type AdminProductDto = Omit<ProductDto, 'variants'> & {
  firstPublishedAt: Date | null
  locked: { slug: boolean }
  variants: AdminVariantDto[]
}

const asStrings = (j: unknown): string[] => (Array.isArray(j) ? (j as string[]) : [])

/**
 * The admin view of one product, in any status. Every product and variant
 * write returns this, so the console re-renders from the server's truth.
 *
 * A variant is locked (SKU and delete) once it has any order line or any
 * channel listing that is not retired (spec §4.2).
 */
export async function loadAdminProduct(id: string): Promise<AdminProductDto | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
      variants: {
        orderBy: { sku: 'asc' },
        include: { inventory: true, channelListing: true, _count: { select: { orderLines: true } } },
      },
    },
  })
  if (!p) return null

  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    images: p.images.map((i) => ({ storageKey: i.storageKey, alt: i.alt, width: i.width, height: i.height, position: i.position })),
    categories: asStrings(p.categories),
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: asStrings(p.features),
    includes: asStrings(p.includes),
    builderNotes: p.builderNotes ?? '',
    homePosition: p.homePosition ?? null,
    collectionPosition: p.collectionPosition ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    firstPublishedAt: p.firstPublishedAt,
    locked: { slug: p.firstPublishedAt !== null },
    variants: p.variants.map((v) => {
      const onHand = v.inventory?.onHand ?? 0
      const reserved = v.inventory?.reserved ?? 0
      const walmartAllocation = v.inventory?.walmartAllocation ?? null
      const locked = v._count.orderLines > 0 || (v.channelListing !== null && v.channelListing.status !== 'retired')
      return {
        id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency,
        attributes: (v.attributes && typeof v.attributes === 'object' && !Array.isArray(v.attributes)
          ? v.attributes : {}) as Record<string, string>,
        inventory: {
          onHand, reserved, walmartAllocation,
          storefrontAvailable: storefrontSellable(onHand, reserved, walmartAllocation),
          walmartAvailable: walmartSellable(onHand, reserved, walmartAllocation),
        },
        locked: { sku: locked, delete: locked },
      }
    }),
  }
}

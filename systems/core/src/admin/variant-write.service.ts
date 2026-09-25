import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError, mapUniqueViolation } from './admin-errors.js'
import { parseVariantInput, type VariantData } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'

async function reload(productId: string): Promise<AdminProductDto> {
  const p = await loadAdminProduct(productId)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

async function insert(tx: Prisma.TransactionClient, productId: string, v: VariantData, actorId: string) {
  const created = await tx.variant.create({
    data: {
      productId, sku: v.sku!, priceCents: v.priceCents!, attributes: v.attributes ?? {},
      inventory: { create: { onHand: v.onHand ?? 0 } },
    },
  })
  await recordAudit({
    actorId, action: 'variant.create', target: `variant:${created.id}`,
    after: { productId, sku: created.sku, priceCents: created.priceCents, attributes: v.attributes ?? {}, onHand: v.onHand ?? 0 },
  }, tx)
}

async function requireProduct(tx: Prisma.TransactionClient, productId: string) {
  if (!(await tx.product.findUnique({ where: { id: productId }, select: { id: true } }))) {
    throw new AdminError('NOT_FOUND', 'product not found')
  }
}

export async function createVariant(productId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const v = parseVariantInput(body, 'create')
  try {
    await prisma.$transaction(async (tx) => {
      await requireProduct(tx, productId)
      await insert(tx, productId, v, actorId)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

/** All-or-nothing: one bad row and nothing is created (spec §3). */
export async function bulkCreateVariants(productId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const rows = (typeof body === 'object' && body !== null ? (body as { variants?: unknown }).variants : undefined)
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { variants: 'a list of 1–50 variants' })
  }
  const fields: Record<string, string> = {}
  const parsed: { i: number; v: VariantData }[] = []
  rows.forEach((row, i) => {
    try { parsed.push({ i, v: parseVariantInput(row, 'create', `variants.${i}.`) }) } catch (e) {
      if (!(e instanceof AdminError) || !e.fields) throw e
      Object.assign(fields, e.fields)
    }
  })
  const seen = new Map<string, number>()
  parsed.forEach(({ i, v }) => {
    if (seen.has(v.sku!)) fields[`variants.${i}.sku`] = `duplicates row ${seen.get(v.sku!)! + 1}`
    else seen.set(v.sku!, i)
  })
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)

  try {
    await prisma.$transaction(async (tx) => {
      await requireProduct(tx, productId)
      for (const { v } of parsed) await insert(tx, productId, v, actorId)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

async function loadForLock(tx: Prisma.TransactionClient, variantId: string) {
  const v = await tx.variant.findUnique({
    where: { id: variantId },
    include: { channelListing: true, _count: { select: { orderLines: true } } },
  })
  if (!v) throw new AdminError('NOT_FOUND', 'variant not found')
  const locked = v._count.orderLines > 0 || (v.channelListing !== null && v.channelListing.status !== 'retired')
  return { v, locked }
}

export async function updateVariant(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseVariantInput(body, 'patch')
  let productId = ''
  try {
    await prisma.$transaction(async (tx) => {
      const { v, locked } = await loadForLock(tx, variantId)
      productId = v.productId
      if (data.sku !== undefined && data.sku !== v.sku && locked) {
        throw new AdminError(
          'SKU_LOCKED',
          'the SKU cannot change once the variant has sold or has a Walmart listing',
          { sku: 'locked after sale or listing' },
        )
      }
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(data)) {
        const old = (v as Record<string, unknown>)[k]
        if (JSON.stringify(old ?? null) !== JSON.stringify(val ?? null)) { before[k] = old ?? null; after[k] = val }
      }
      if (Object.keys(after).length === 0) return
      await tx.variant.update({ where: { id: variantId }, data: after })
      await recordAudit({ actorId, action: 'variant.update', target: `variant:${variantId}`, before, after }, tx)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

/**
 * Refused once sold or listed. The listing FK cascades, so without this check
 * a delete would silently erase the record of a listing that may still be
 * live on Walmart (spec §4.2).
 */
export async function deleteVariant(variantId: string, actorId: string): Promise<AdminProductDto> {
  let productId = ''
  await prisma.$transaction(async (tx) => {
    const { v, locked } = await loadForLock(tx, variantId)
    productId = v.productId
    if (locked) {
      throw new AdminError('VARIANT_HAS_SALES', 'this variant has sold or is listed on Walmart; archive the product instead of deleting it')
    }
    await tx.variant.delete({ where: { id: variantId } })
    await recordAudit({
      actorId, action: 'variant.delete', target: `variant:${variantId}`,
      before: { productId: v.productId, sku: v.sku, priceCents: v.priceCents },
    }, tx)
  })
  return reload(productId)
}

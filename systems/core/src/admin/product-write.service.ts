import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError, mapUniqueViolation } from './admin-errors.js'
import { parseProductInput } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'
import { setProductStatus } from './admin-catalog.service.js'

async function reload(id: string): Promise<AdminProductDto> {
  const p = await loadAdminProduct(id)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

/** Always a draft, whatever the body says — publishing is its own act. */
export async function createProduct(body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseProductInput(body, 'create')
  let id: string
  try {
    id = await prisma.$transaction(async (tx) => {
      // parseProductInput('create') guarantees name, slug and productType.
      const p = await tx.product.create({ data: { ...data, status: 'draft' } as Prisma.ProductUncheckedCreateInput })
      await recordAudit({ actorId, action: 'product.create', target: `product:${p.id}`, after: data }, tx)
      return p.id
    })
  } catch (e) {
    throw mapUniqueViolation(e)
  }
  return reload(id)
}

/**
 * Partial update. Only fields whose value actually changes are written and
 * audited; a no-op patch writes nothing.
 */
export async function updateProduct(id: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseProductInput(body, 'patch')
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id } })
      if (!existing) throw new AdminError('NOT_FOUND', 'product not found')

      if (data.slug !== undefined && data.slug !== existing.slug && existing.firstPublishedAt !== null) {
        throw new AdminError(
          'SLUG_LOCKED',
          'the slug cannot change once a product has been published: its URL may already be linked or indexed',
          { slug: 'locked after first publish' },
        )
      }

      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) {
        const old = (existing as Record<string, unknown>)[k]
        if (JSON.stringify(old ?? null) !== JSON.stringify(v ?? null)) { before[k] = old ?? null; after[k] = v }
      }
      if (Object.keys(after).length === 0) return

      await tx.product.update({ where: { id }, data: after })
      await recordAudit({ actorId, action: 'product.update', target: `product:${id}`, before, after }, tx)
    })
  } catch (e) {
    throw mapUniqueViolation(e)
  }
  return reload(id)
}

/**
 * Each product is its own transaction through setProductStatus, so one
 * refused transition never rolls back the others (spec §3).
 */
export async function bulkSetStatus(body: unknown, actorId: string) {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { ids?: unknown; status?: unknown }
  const ids = b.ids
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every((x) => typeof x === 'string')) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { ids: 'a list of 1–100 product ids' })
  }
  if (typeof b.status !== 'string') {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { status: 'required' })
  }
  const results: Array<{ id: string; ok: boolean; code?: string; message?: string }> = []
  for (const id of ids as string[]) {
    try {
      await setProductStatus(id, b.status, actorId)
      results.push({ id, ok: true })
    } catch (e) {
      if (!(e instanceof AdminError)) throw e
      results.push({ id, ok: false, code: e.code, message: e.message })
    }
  }
  return { results }
}

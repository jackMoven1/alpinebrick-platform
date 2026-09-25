import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import * as inventorySync from '../channels/walmart/inventory.sync.js'
import { AdminError } from './admin-errors.js'
import { parseStockInput } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'

type Row = { on_hand: number; reserved: number; walmart_allocation: number | null }

/**
 * Absolute stock and/or Walmart allocation (spec §5, §5.1).
 *
 * The row is locked (SELECT ... FOR UPDATE) before anything is decided, so a
 * checkout or Walmart ingest racing this change waits for it and then
 * re-evaluates its own guard against the new figures. The UPDATE repeats the
 * invariant in its WHERE clause as a second line of defence. Remove the lock
 * and tests/stock-concurrency.test.ts fails.
 */
export async function setStock(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const input = parseStockInput(body)

  const productId = await prisma.$transaction(async (tx) => {
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { productId: true } })
    if (!variant) throw new AdminError('NOT_FOUND', 'variant not found')
    await tx.inventory.upsert({ where: { variantId }, create: { variantId }, update: {} })

    const [cur] = await tx.$queryRaw<Row[]>`
      SELECT on_hand, reserved, walmart_allocation FROM inventory WHERE variant_id = ${variantId} FOR UPDATE`
    const before = { onHand: cur.on_hand, reserved: cur.reserved, walmartAllocation: cur.walmart_allocation }

    if (input.expectedOnHand !== undefined && cur.on_hand !== input.expectedOnHand) {
      throw new AdminError('STOCK_CHANGED', `stock changed to ${cur.on_hand} since you opened this`, undefined, before)
    }
    const onHand = input.onHand ?? cur.on_hand
    const allocation = input.allocationProvided ? input.walmartAllocation : cur.walmart_allocation
    if (onHand < cur.reserved) {
      throw new AdminError('STOCK_BELOW_RESERVED',
        `on hand cannot go below the ${cur.reserved} reserved by open orders`, { onHand: `at least ${cur.reserved}` }, before)
    }
    if (cur.reserved + (allocation ?? 0) > onHand) {
      throw new AdminError('ALLOCATION_EXCEEDS_AVAILABLE',
        `reserved (${cur.reserved}) plus Walmart allocation (${allocation}) cannot exceed on hand (${onHand}); lower the allocation too`,
        { walmartAllocation: `at most ${onHand - cur.reserved}` }, before)
    }

    const affected = await tx.$executeRaw`
      UPDATE inventory SET on_hand = ${onHand}, walmart_allocation = ${allocation}::int
      WHERE variant_id = ${variantId} AND reserved + COALESCE(${allocation}::int, 0) <= ${onHand}`
    if (affected !== 1) throw new Error(`stock update for ${variantId} matched ${affected} rows under lock`)

    await recordAudit({
      actorId, action: 'variant.stock.set', target: `variant:${variantId}`,
      before, after: { onHand, reserved: cur.reserved, walmartAllocation: allocation, note: input.note ?? null },
    }, tx)
    return variant.productId
  })

  // After commit, like orders.service's enqueueInventoryPushesAfterCommit: a
  // failure is logged, never surfaced as a failed stock change. The hourly
  // reconcile catches up.
  try {
    await inventorySync.enqueueInventoryPush(variantId)
  } catch (e) {
    console.error(`stock: post-commit inventory push enqueue failed (variant ${variantId}):`, e)
  }

  const p = await loadAdminProduct(productId)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

export async function getStockHistory(variantId: string, limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { limit: 'a whole number from 1 to 50' })
  }
  if (!(await prisma.variant.findUnique({ where: { id: variantId }, select: { id: true } }))) {
    throw new AdminError('NOT_FOUND', 'variant not found')
  }
  const rows = await prisma.auditLog.findMany({
    where: { action: 'variant.stock.set', target: `variant:${variantId}` },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: true },
  })
  return rows.map((r) => ({
    at: r.createdAt,
    actor: r.actor.email ?? r.actor.name,
    before: r.before,
    after: r.after,
    note: ((r.after as { note?: string | null } | null)?.note) ?? null,
  }))
}

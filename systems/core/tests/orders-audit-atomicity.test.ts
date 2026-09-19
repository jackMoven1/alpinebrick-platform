import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { markOrderPaid, fulfillOrder, OrderError } from '../src/orders/orders.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

async function seedPendingOrder() {
  const actor = await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
  const product = await prisma.product.create({
    data: {
      slug: 'x', name: 'X', productType: 'resale', status: 'published',
      variants: { create: [{ sku: 'X-1', priceCents: 1000 }] },
    },
    include: { variants: true },
  })
  const order = await prisma.order.create({
    data: {
      status: 'pending', channel: 'storefront',
      email: 'buyer@example.com', shipToState: 'MI',
      subtotalCents: 1000, taxCents: 0, taxRateBps: 0, taxJurisdiction: 'MI', totalCents: 1000,
      lines: {
        create: [{
          variantId: product.variants[0].id, sku: product.variants[0].sku,
          quantity: 1, unitPriceCents: 1000, lineSubtotalCents: 1000,
        }],
      },
    },
  })
  return { order, actor }
}

describe('order audit atomicity', () => {
  it('writes exactly one audit row on a successful transition', async () => {
    const { order } = await seedPendingOrder()
    await markOrderPaid(order.id, 'system')
    const rows = await prisma.auditLog.findMany({ where: { action: 'order.paid' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toBe(`order:${order.id}`)
  })

  // A rejected transition must leave nothing behind.
  it('writes no audit row when the transition is rejected', async () => {
    const { order } = await seedPendingOrder()
    await expect(fulfillOrder(order.id, 'system')).rejects.toBeInstanceOf(OrderError)
    expect(await prisma.auditLog.count()).toBe(0)
  })

  // Forces recordAudit to fail (actorId has no matching Actor row, so the
  // audit insert violates its FK constraint) and checks the order state.
  // This is the test that actually distinguishes "audit call inside the
  // transaction" from "audit call after it": if recordAudit runs inside
  // prisma.$transaction, its failure rolls the order update back too, so the
  // order is still 'pending'. If recordAudit runs after the transaction has
  // already committed, the order is left 'paid' even though the caller sees
  // a rejected promise.
  it('rolls back the order state change when the audit write fails', async () => {
    const { order } = await seedPendingOrder()
    await expect(markOrderPaid(order.id, 'no-such-actor')).rejects.toThrow()
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(fresh.status).toBe('pending')
  })
})

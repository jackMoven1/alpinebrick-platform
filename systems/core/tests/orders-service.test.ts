import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, getOrder, OrderError } from '../src/orders/orders.service.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function variantId(sku: string) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return v.id
}

describe('placeOrder', () => {
  it('creates a pending order, computes Michigan tax, and reserves stock', async () => {
    const vid = await variantId('BBS-STD') // priceCents 4999, onHand 25
    const order = await placeOrder({ email: 'buyer@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 2 }] })

    expect(order.status).toBe('pending')
    expect(order.orderNumber).toMatch(/^ABE-\d{6}$/)
    expect(order.subtotalCents).toBe(9998)
    expect(order.taxCents).toBe(600)          // 9998 * 6% = 599.88 -> 600
    expect(order.totalCents).toBe(10598)

    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(2)
    expect(inv.onHand).toBe(25)               // on_hand unchanged until fulfillment
  })

  it('charges no tax when shipping outside a nexus state', async () => {
    const vid = await variantId('BBS-STD')
    const order = await placeOrder({ email: 'b@example.com', shipToState: 'CA', lines: [{ variantId: vid, quantity: 1 }] })
    expect(order.taxCents).toBe(0)
    expect(order.totalCents).toBe(4999)
  })

  it('rejects an order that exceeds available stock and reserves nothing', async () => {
    const vid = await variantId('CMP-LTD') // onHand 8
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 9 }] }))
      .rejects.toMatchObject({ code: 'insufficient_stock' })
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(0)
  })

  it('rejects a line for a non-published or unknown variant', async () => {
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: 'does-not-exist', quantity: 1 }] }))
      .rejects.toBeInstanceOf(OrderError)
  })

  it('rejects an empty order and a non-positive quantity', async () => {
    const vid = await variantId('BBS-STD')
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [] })).rejects.toMatchObject({ code: 'empty_order' })
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 0 }] }))
      .rejects.toMatchObject({ code: 'invalid_quantity' })
  })

  it('writes an order.place audit row', async () => {
    const vid = await variantId('BBS-STD')
    const order = await placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const audit = await prisma.auditLog.findFirst({ where: { action: 'order.place', target: `order:${order.id}` } })
    expect(audit).not.toBeNull()
  })

  it('getOrder returns the persisted order or null', async () => {
    const vid = await variantId('BBS-STD')
    const placed = await placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const fetched = await getOrder(placed.id)
    expect(fetched?.id).toBe(placed.id)
    expect(await getOrder('nope')).toBeNull()
  })
})

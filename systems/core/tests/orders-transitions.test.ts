import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, markOrderPaid, fulfillOrder, cancelOrder } from '../src/orders/orders.service.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function place(sku: string, qty: number) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: qty }] })
}

describe('order transitions', () => {
  it('fulfilling a paid order decrements on_hand and releases the reservation', async () => {
    const order = await place('BBS-STD', 3) // onHand 25 -> reserved 3
    await markOrderPaid(order.id)
    const done = await fulfillOrder(order.id)
    expect(done.status).toBe('fulfilled')
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })
    expect(inv.onHand).toBe(22)
    expect(inv.reserved).toBe(0)
  })

  it('cancelling a pending order releases the reservation without touching on_hand', async () => {
    const order = await place('BBS-STD', 4)
    const cancelled = await cancelOrder(order.id)
    expect(cancelled.status).toBe('cancelled')
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })
    expect(inv.onHand).toBe(25)
    expect(inv.reserved).toBe(0)
  })

  it('refuses to fulfill an order that is not paid', async () => {
    const order = await place('BBS-STD', 1) // still pending
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('refuses to cancel a fulfilled order', async () => {
    const order = await place('BBS-STD', 1)
    await markOrderPaid(order.id)
    await fulfillOrder(order.id)
    await expect(cancelOrder(order.id)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('writes audit rows for each transition', async () => {
    const order = await place('BBS-STD', 1)
    await markOrderPaid(order.id)
    await fulfillOrder(order.id)
    const actions = (await prisma.auditLog.findMany({ where: { target: `order:${order.id}` } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['order.place', 'order.paid', 'order.fulfilled']))
  })
})

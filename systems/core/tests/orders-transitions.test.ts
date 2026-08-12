import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, getOrder, markOrderPaid, fulfillOrder, cancelOrder } from '../src/orders/orders.service.js'

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

  it('refuses to cancel when the reservation has drifted below the line quantity', async () => {
    const order = await place('BBS-STD', 3) // reserved 3
    const inv0 = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })

    // Simulate a drifted hold: reserved is now less than this order's line quantity.
    // Nothing in the service can produce this — the status guard makes double-cancel
    // impossible — so it stands in for external corruption (a manual edit, a
    // partially-applied earlier failure). The point is that the release must not
    // silently no-op and strand the remaining hold forever.
    await prisma.inventory.update({ where: { id: inv0.id }, data: { reserved: 1 } })

    await expect(cancelOrder(order.id)).rejects.toMatchObject({ code: 'inventory_conflict' })

    // The whole transition rolls back: the order stays cancellable rather than
    // becoming cancelled with its hold stranded.
    expect((await getOrder(order.id))?.status).toBe('pending')
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })
    expect(inv.reserved).toBe(1) // untouched, and never driven negative
  })

  it('writes audit rows for each transition', async () => {
    const order = await place('BBS-STD', 1)
    await markOrderPaid(order.id)
    await fulfillOrder(order.id)
    const actions = (await prisma.auditLog.findMany({ where: { target: `order:${order.id}` } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['order.place', 'order.paid', 'order.fulfilled']))
  })
})

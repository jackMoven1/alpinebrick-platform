import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { storefrontSellable, walmartSellable } from '../src/inventory/allocation.js'
import { placeOrder, cancelOrder } from '../src/orders/orders.service.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { getAvailability } from '../src/catalog/catalog.service.js'
import { pushInventoryForVariant } from '../src/channels/walmart/inventory.sync.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

describe('sellable figures (spec §5.1 table)', () => {
  it('shared: both channels see on_hand - reserved', () => {
    expect(storefrontSellable(5, 2, null)).toBe(3)
    expect(walmartSellable(5, 2, null)).toBe(3)
  })
  it('split: Walmart gets min(N, free), storefront the rest', () => {
    expect(walmartSellable(10, 0, 3)).toBe(3)
    expect(storefrontSellable(10, 0, 3)).toBe(7)
  })
  it('a single collectible: 1 = Walmart only, 0 = storefront only', () => {
    expect([walmartSellable(1, 0, 1), storefrontSellable(1, 0, 1)]).toEqual([1, 0])
    expect([walmartSellable(1, 0, 0), storefrontSellable(1, 0, 0)]).toEqual([0, 1])
  })
  it('never negative', () => {
    expect(storefrontSellable(1, 1, 1)).toBe(0)
    expect(walmartSellable(0, 0, 3)).toBe(0)
  })
})

// The Walmart fixture sells SKU ABE-SET-001-W, quantity 2.
async function makeVariant(onHand: number, walmartAllocation: number | null) {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'resale', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, walmartAllocation } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  return v
}
const inv = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } })
const storefront = (variantId: string, quantity: number) =>
  placeOrder({ email: 'a@example.com', shipToState: 'MI', lines: [{ variantId, quantity }] })

describe('allocation in the stock paths', () => {
  beforeEach(async () => { await resetDb(); await ensureSystemActor() })
  afterAll(() => prisma.$disconnect())

  it('storefront cannot buy units allocated to Walmart', async () => {
    const v = await makeVariant(3, 2)
    await storefront(v.id, 1)
    await expect(storefront(v.id, 1)).rejects.toMatchObject({ code: 'insufficient_stock' })
  })

  it('shared stock lets the storefront take everything', async () => {
    const v = await makeVariant(2, null)
    await storefront(v.id, 2)
    expect((await inv(v.id)).reserved).toBe(2)
  })

  it('a Walmart sale consumes its allocation', async () => {
    const v = await makeVariant(5, 3)
    await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([2, 1])
  })

  it('a Walmart order beyond its allocation is refused', async () => {
    await makeVariant(5, 1)
    await expect(ingestWalmartOrder(walmartOrderFixture, 'webhook')).rejects.toMatchObject({ code: 'insufficient_stock' })
  })

  it('shared stock lets Walmart take everything, allocation stays null', async () => {
    const v = await makeVariant(2, null)
    await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([2, null])
  })

  it('cancelling a Walmart order returns the units to Walmart', async () => {
    const v = await makeVariant(5, 3)
    const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    await cancelOrder(orderId!)
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([0, 3])
  })

  it('cancelling a storefront order does not touch the allocation', async () => {
    const v = await makeVariant(5, 2)
    const o = await storefront(v.id, 2)
    await cancelOrder(o.id)
    expect((await inv(v.id)).walmartAllocation).toBe(2)
  })

  it('public availability excludes Walmart-allocated units', async () => {
    const v = await makeVariant(5, 2)
    const rows = await getAvailability('castle')
    expect(rows?.find((r) => r.variantId === v.id)?.available).toBe(3)
  })

  it('pushes Walmart its sellable figure, with no percentage buffer', async () => {
    const v = await makeVariant(1, null)
    const calls: any[] = []
    const client: WalmartClient = { request: async (method, path, opts) => { calls.push(opts); return {} } }
    await pushInventoryForVariant(v.id, client)
    expect(calls[0].body.quantity.amount).toBe(1) // the old 10%-min-1 buffer sent 0
  })
})

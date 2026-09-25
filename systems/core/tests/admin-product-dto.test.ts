import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { loadAdminProduct } from '../src/admin/admin-product.dto.js'

beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

async function product(firstPublishedAt: Date | null = null) {
  return prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale', firstPublishedAt } })
}
async function variant(productId: string, sku: string, onHand = 5, reserved = 1, walmartAllocation: number | null = 2) {
  const v = await prisma.variant.create({ data: { productId, sku, priceCents: 1000, attributes: { condition: 'sealed' } } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved, walmartAllocation } })
  return v
}

describe('loadAdminProduct', () => {
  it('returns null for an unknown id', async () => {
    expect(await loadAdminProduct('nope')).toBeNull()
  })

  it('reports inventory for each channel and the attributes', async () => {
    const p = await product()
    await variant(p.id, 'A-1')
    const dto = await loadAdminProduct(p.id)
    expect(dto!.variants[0]).toMatchObject({
      sku: 'A-1', attributes: { condition: 'sealed' },
      inventory: { onHand: 5, reserved: 1, walmartAllocation: 2, storefrontAvailable: 2, walmartAvailable: 2 },
      locked: { sku: false, delete: false },
    })
  })

  it('reports a variant without an inventory row as zero stock', async () => {
    const p = await product()
    await prisma.variant.create({ data: { productId: p.id, sku: 'B-1', priceCents: 100 } })
    expect((await loadAdminProduct(p.id))!.variants[0].inventory)
      .toEqual({ onHand: 0, reserved: 0, walmartAllocation: null, storefrontAvailable: 0, walmartAvailable: 0 })
  })

  it('reports the Walmart listing status, or null when there is none', async () => {
    const p = await product()
    await variant(p.id, 'N-1')
    const listed = await variant(p.id, 'W-1')
    await prisma.channelListing.create({ data: { variantId: listed.id, walmartSku: 'W-1-W', status: 'live' } })
    const bySku = Object.fromEntries((await loadAdminProduct(p.id))!.variants.map((v) => [v.sku, v.walmartListing]))
    expect(bySku).toEqual({ 'N-1': null, 'W-1': { status: 'live' } })
  })

  it('locks the slug once first published', async () => {
    expect((await loadAdminProduct((await product()).id))!.locked.slug).toBe(false)
    await resetDb()
    expect((await loadAdminProduct((await product(new Date())).id))!.locked.slug).toBe(true)
  })

  it('locks SKU and delete for a sold variant and for a non-retired listing, not for a retired one', async () => {
    const p = await product()
    const sold = await variant(p.id, 'S-1')
    const listed = await variant(p.id, 'L-1')
    const retired = await variant(p.id, 'R-1')
    const order = await prisma.order.create({ data: {
      email: 'a@example.com', shipToState: 'MI', status: 'paid', subtotalCents: 1000, taxCents: 0, totalCents: 1000,
      taxRateBps: 0, taxJurisdiction: 'MI', lines: { create: [{ variantId: sold.id, sku: 'S-1', quantity: 1, unitPriceCents: 1000, lineSubtotalCents: 1000 }] },
    } })
    expect(order.id).toBeTruthy()
    await prisma.channelListing.create({ data: { variantId: listed.id, walmartSku: 'L-1-W', status: 'live' } })
    await prisma.channelListing.create({ data: { variantId: retired.id, walmartSku: 'R-1-W', status: 'retired' } })
    const bySku = Object.fromEntries((await loadAdminProduct(p.id))!.variants.map((v) => [v.sku, v.locked]))
    expect(bySku).toEqual({
      'L-1': { sku: true, delete: true },
      'R-1': { sku: false, delete: false },
      'S-1': { sku: true, delete: true },
    })
  })
})

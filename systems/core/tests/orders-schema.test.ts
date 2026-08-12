import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('order schema', () => {
  it('persists an order with lines and defaults to pending', async () => {
    const variant = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const order = await prisma.order.create({
      data: {
        email: 'buyer@example.com', shipToState: 'MI',
        subtotalCents: 4999, taxCents: 300, totalCents: 5299,
        taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [{
          variantId: variant.id, sku: variant.sku, quantity: 1,
          unitPriceCents: 4999, lineSubtotalCents: 4999,
        }] },
      },
      include: { lines: true },
    })
    expect(order.status).toBe('pending')
    expect(order.number).toBeGreaterThan(0)
    expect(order.lines).toHaveLength(1)
    expect(order.totalCents).toBe(5299)
  })

  it('cascade-deletes lines when the order is deleted', async () => {
    const variant = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const order = await prisma.order.create({
      data: {
        email: 'x@example.com', shipToState: 'MI',
        subtotalCents: 4999, taxCents: 300, totalCents: 5299, taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [{ variantId: variant.id, sku: variant.sku, quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }] },
      },
    })
    await prisma.order.delete({ where: { id: order.id } })
    expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(0)
  })

  it('defaults discountCents to 0, and reconciles line discounts to the order exactly', async () => {
    const variant = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })

    // Nothing in this plan writes a discount — the default is what every order gets.
    const plain = await prisma.order.create({
      data: {
        email: 'plain@example.com', shipToState: 'MI',
        subtotalCents: 4999, taxCents: 300, totalCents: 5299, taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [{ variantId: variant.id, sku: variant.sku, quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }] },
      },
      include: { lines: true },
    })
    expect(plain.discountCents).toBe(0)
    expect(plain.lines[0].discountCents).toBe(0)

    // Allocation itself belongs to the plan that introduces discounts; this pins the
    // shape that plan must produce. 501c over 3000c + 2000c: raw 300.6 / 200.4, floors
    // 300 + 200, residual 1c to the largest remainder -> 301 / 200.
    const discounted = await prisma.order.create({
      data: {
        email: 'disc@example.com', shipToState: 'MI',
        // Tax on the discounted base: round((5000 - 501) * 600 / 10000) = 270.
        // Total: 5000 - 501 + 270 = 4769.
        subtotalCents: 5000, discountCents: 501,
        taxCents: 270, totalCents: 4769, taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [
          { variantId: variant.id, sku: variant.sku, quantity: 1, unitPriceCents: 3000, lineSubtotalCents: 3000, discountCents: 301 },
          { variantId: variant.id, sku: variant.sku, quantity: 1, unitPriceCents: 2000, lineSubtotalCents: 2000, discountCents: 200 },
        ] },
      },
      include: { lines: true },
    })
    expect(discounted.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(discounted.discountCents)
    for (const line of discounted.lines) {
      expect(line.discountCents).toBeGreaterThanOrEqual(0)
      expect(line.discountCents).toBeLessThanOrEqual(line.lineSubtotalCents)
    }
  })
})

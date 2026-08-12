import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder } from '../src/orders/orders.service.js'

// The reservation UPDATE in placeOrder is guarded by `on_hand - reserved >= qty`,
// evaluated by Postgres during the write rather than read-then-written in JS.
// That is what makes overselling impossible: a loser blocks on the winner's row
// lock, re-evaluates after it commits, matches zero rows, and raises
// insufficient_stock.
//
// Every other test in this suite is single-threaded and cannot observe that.
// These tests fire genuinely concurrent placeOrder calls on one variant.
// vitest's `fileParallelism: false` only serialises test FILES; promises inside
// a single test still run concurrently, and Prisma's pool (cpus*2+1) hands each
// transaction its own connection, so these really do race.
//
// Guard against a vacuous pass: if the reservation is rewritten as a read-then-
// write, these tests must fail. That was verified by temporarily doing exactly
// that -- see the PR description.

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function setStock(sku: string, onHand: number) {
  const variant = await prisma.variant.findFirstOrThrow({ where: { sku } })
  const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } })
  await prisma.inventory.update({ where: { id: inv.id }, data: { onHand, reserved: 0 } })
  return variant.id
}

function race(variantId: string, attempts: number, quantity: number) {
  return Promise.allSettled(
    Array.from({ length: attempts }, () =>
      placeOrder({ email: 'race@example.com', shipToState: 'MI', lines: [{ variantId, quantity }] }),
    ),
  )
}

function partition(results: PromiseSettledResult<unknown>[]) {
  return {
    won: results.filter((r) => r.status === 'fulfilled'),
    lost: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected'),
  }
}

describe('concurrent reservation', () => {
  it('lets exactly one of many simultaneous orders take the last unit', async () => {
    const vid = await setStock('CMP-LTD', 1)

    const { won, lost } = partition(await race(vid, 8, 1))

    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(7)
    for (const l of lost) expect(l.reason).toMatchObject({ code: 'insufficient_stock' })

    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(1)   // never 8 — that would be the oversell
    expect(inv.onHand).toBe(1)     // untouched until fulfilment
    expect(await prisma.order.count()).toBe(1)
  })

  it('reserves up to available capacity and no further when demand overshoots', async () => {
    // 4 units, six concurrent orders of 2: capacity is exactly two orders.
    const vid = await setStock('CMP-LTD', 4)

    const { won, lost } = partition(await race(vid, 6, 2))

    expect(won).toHaveLength(2)
    expect(lost).toHaveLength(4)
    for (const l of lost) expect(l.reason).toMatchObject({ code: 'insufficient_stock' })

    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(4)                 // exactly consumed, never exceeded
    expect(inv.reserved).toBeLessThanOrEqual(inv.onHand)
    expect(await prisma.order.count()).toBe(2)
  })

  it('never reserves more than is on hand, across a burst of mixed quantities', async () => {
    const vid = await setStock('CMP-LTD', 5)

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 1, 2, 3].map((quantity) =>
        placeOrder({ email: 'race@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity }] }),
      ),
    )
    const { won } = partition(results)

    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    // The invariant that matters, whatever interleaving occurred.
    expect(inv.reserved).toBeLessThanOrEqual(5)
    expect(inv.reserved).toBeGreaterThan(0)

    // Reserved must equal exactly what the winning orders asked for.
    const orders = await prisma.order.findMany({ include: { lines: true } })
    const ordered = orders.flatMap((o) => o.lines).reduce((s, l) => s + l.quantity, 0)
    expect(inv.reserved).toBe(ordered)
    expect(orders).toHaveLength(won.length)
  })
})

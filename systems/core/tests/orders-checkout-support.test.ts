import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import {
  placeOrder, markOrderPaid, fulfillOrder, cancelOrder, refundOrderTx, OrderError, PENDING_CHECKOUT_EMAIL,
  lockOrderRow, markOrderPaidTx, cancelOrderTx,
} from '../src/orders/orders.service.js'
import { BEFORE_QUOTE_TAX } from '../src/checkout/checkout.service.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function vid(sku: string) { return (await prisma.variant.findFirstOrThrow({ where: { sku } })).id }
async function inv(variantId: string) { return prisma.inventory.findFirstOrThrow({ where: { variantId } }) }
const pending = (variantId: string, quantity = 1) => placeOrder(
  { email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId, quantity }] }, BEFORE_QUOTE_TAX,
)
const refund = (orderId: string, refundedCents: number, full: boolean) =>
  prisma.$transaction((tx) => refundOrderTx(tx, orderId, { refundedCents, full }))

describe('placeOrder for checkout', () => {
  it('records opt-in and referral, with tax left for the quote', async () => {
    const v = await vid('BBS-STD')
    const o = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: v, quantity: 2 }],
      marketingOptIn: true, referral: { code: 'club', firstSeenAt: new Date('2026-09-20T00:00:00Z') },
    }, BEFORE_QUOTE_TAX)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row).toMatchObject({
      taxCents: 0, taxRateBps: 0, taxJurisdiction: 'quote_pending', totalCents: 9998,
      marketingOptIn: true, referralCode: 'club', referralFirstSeenAt: new Date('2026-09-20T00:00:00Z'),
    })
  })

  it('reports how many units are available on insufficient stock', async () => {
    const v = await vid('CMP-LTD') // onHand 8
    await pending(v, 3)
    const err = await pending(v, 6).catch((e) => e)
    expect(err).toBeInstanceOf(OrderError)
    expect(err).toMatchObject({ code: 'insufficient_stock', details: { variantId: v, available: 5 } })
  })

  it('names the missing variant', async () => {
    await expect(pending('nope')).rejects.toMatchObject({ code: 'variant_not_found', details: { variantId: 'nope' } })
  })
})

describe('refundOrderTx', () => {
  it('full refund of a paid order releases the reservation', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    const { releasedVariantIds } = await refund(o.id, 9998, true)
    expect(releasedVariantIds).toEqual([v])
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'refunded', refundedCents: 9998 })
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
    expect(await prisma.auditLog.count({ where: { action: 'order.refunded', target: `order:${o.id}` } })).toBe(1)
  })

  it('full refund after shipment leaves stock alone', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    await markOrderPaid(o.id)
    await fulfillOrder(o.id)
    const { releasedVariantIds } = await refund(o.id, 4999, true)
    expect(releasedVariantIds).toEqual([])
    expect(await inv(v)).toMatchObject({ onHand: 24, reserved: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  it('partial refund changes the amount only', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 1000, false)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', refundedCents: 1000 })
    expect((await inv(v)).reserved).toBe(2)
  })

  it('full refund of a cancelled order does not release twice', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    await cancelOrder(o.id)
    await refund(o.id, 4999, true)
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  it('refuses a full refund of a pending order', async () => {
    const o = await pending(await vid('BBS-STD'))
    await expect(refund(o.id, 4999, true)).rejects.toMatchObject({ code: 'invalid_transition' })
  })
})

// Fix round 1 (Ruling T4-R1): the refunded total is cumulative, but refund
// webhooks are distinct and can arrive out of order, so an older, smaller
// figure must never lower the amount or downgrade the status.
describe('refundOrderTx is monotonic and validated', () => {
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
  const audits = (id: string, action: string) => prisma.auditLog.count({ where: { action, target: `order:${id}` } })

  it('an out-of-order partial after a full refund changes nothing', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 9998, true)
    const { order, releasedVariantIds } = await refund(o.id, 1000, false)
    expect(releasedVariantIds).toEqual([])
    expect(order).toMatchObject({ status: 'refunded', refundedCents: 9998 })
    expect(await orderRow(o.id)).toMatchObject({ status: 'refunded', refundedCents: 9998 })
    expect(await audits(o.id, 'order.refund_partial')).toBe(0)
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
  })

  it('a lower partial after a higher one never lowers the amount', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 3000, false)
    await refund(o.id, 1000, false)
    expect(await orderRow(o.id)).toMatchObject({ status: 'paid', refundedCents: 3000 })
    expect(await audits(o.id, 'order.refund_partial')).toBe(1)
    expect((await inv(v)).reserved).toBe(2)
  })

  it('a full refund carrying a lower figure keeps the higher amount', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 9998, false)
    await refund(o.id, 5000, true)
    expect(await orderRow(o.id)).toMatchObject({ status: 'refunded', refundedCents: 9998 })
  })

  it.each([
    ['non-integer', 10.5],
    ['negative', -1],
    ['greater than the order total', 9999],
    ['NaN', Number.NaN],
  ])('rejects a %s amount', async (_label, amount) => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2) // totalCents 9998
    await markOrderPaid(o.id)
    await expect(refund(o.id, amount, false)).rejects.toMatchObject({ code: 'invalid_refund' })
    await expect(refund(o.id, amount, true)).rejects.toMatchObject({ code: 'invalid_refund' })
    expect(await orderRow(o.id)).toMatchObject({ status: 'paid', refundedCents: 0 })
    expect((await inv(v)).reserved).toBe(2)
  })

  it('a repeat full refund is a no-op: one audit row, stock released once', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 9998, true)
    const again = await refund(o.id, 9998, true)
    expect(again.releasedVariantIds).toEqual([])
    expect(again.order).toMatchObject({ status: 'refunded', refundedCents: 9998 })
    expect(await audits(o.id, 'order.refunded')).toBe(1)
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
  })
})

// Fix round 1 (Ruling T8-R1): cancelOrderTx({ onlyIfPending: true }) must be
// a pure no-op against a paid order -- no update, no stock release, no audit
// row -- so a storefront-initiated cancel that loses a race against the
// paid webhook can never undo it.
describe('cancelOrderTx with onlyIfPending', () => {
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
  const audits = (id: string, action: string) => prisma.auditLog.count({ where: { action, target: `order:${id}` } })

  it('is a no-op against a paid order: no status change, no release, no audit row', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    const before = await audits(o.id, 'order.cancelled')

    const result = await prisma.$transaction((tx) => cancelOrderTx(tx, o.id, 'system', { onlyIfPending: true }))

    expect(result).toBeNull()
    expect(await orderRow(o.id)).toMatchObject({ status: 'paid' })
    expect((await inv(v)).reserved).toBe(2)
    expect(await audits(o.id, 'order.cancelled')).toBe(before)
  })

  it('still cancels a pending order normally', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)

    const result = await prisma.$transaction((tx) => cancelOrderTx(tx, o.id, 'system', { onlyIfPending: true }))

    expect(result).not.toBeNull()
    expect(await orderRow(o.id)).toMatchObject({ status: 'cancelled' })
    expect((await inv(v)).reserved).toBe(0)
  })
})

/**
 * Deterministic lock tests (controller Ruling P3). Transaction A takes the
 * order row lock and holds it on a gate; a second transition is started
 * concurrently and must NOT complete while A holds the lock. A then applies
 * its own transition and commits; the second transition must see A's
 * committed status. Without `FOR UPDATE` in lockOrderRow, A holds no lock, the
 * second transition runs to completion immediately, and the "still blocked"
 * assertion fails.
 */
describe('transitions lock the order row', () => {
  const HOLD_MS = 500

  async function holdLockThen(orderId: string, transition: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    let signalLocked!: () => void
    const locked = new Promise<void>((r) => { signalLocked = r })
    const txA = prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, orderId)
      signalLocked()
      await gate
      await transition(tx)
    }, { timeout: 15_000 })
    await locked
    return { txA, release: () => open() }
  }

  function track<T>(p: Promise<T>) {
    const state = { settled: false }
    const settled = p.then(
      (value) => { state.settled = true; return { ok: true as const, value } },
      (error) => { state.settled = true; return { ok: false as const, error } },
    )
    return { state, settled }
  }

  it('cancel blocks while paid holds the lock, then cancels the paid order and releases its hold', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    const { txA, release } = await holdLockThen(o.id, (tx) => markOrderPaidTx(tx, o.id))

    const cancel = track(cancelOrder(o.id))
    await new Promise((r) => setTimeout(r, HOLD_MS))
    // Read before releasing, and always release, so a failure here never
    // leaves tx A holding its connection until the transaction timeout.
    const blockedWhileLocked = !cancel.state.settled
    release()
    const aError = await txA.then(() => null, (e) => e)
    expect(blockedWhileLocked).toBe(true)
    expect(aError).toBeNull()
    const result = await cancel.settled
    // txA resolved, so paid committed first; paid -> cancelled is legal, so
    // cancel must then succeed on the paid order and release the hold once.
    expect(result.ok).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    expect((await inv(v)).reserved).toBe(0)
    const actions = (await prisma.auditLog.findMany({ where: { target: `order:${o.id}` } })).map((a) => a.action).sort()
    expect(actions).toEqual(['order.cancelled', 'order.paid', 'order.place'])
  })

  it('paid blocks while cancel holds the lock, then refuses -- never a paid order with its hold released', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    const { txA, release } = await holdLockThen(o.id, (tx) => cancelOrderTx(tx, o.id))

    const paid = track(markOrderPaid(o.id))
    await new Promise((r) => setTimeout(r, HOLD_MS))
    // Read before releasing, and always release, so a failure here never
    // leaves tx A holding its connection until the transaction timeout.
    const blockedWhileLocked = !paid.state.settled
    release()
    const aError = await txA.then(() => null, (e) => e)
    expect(blockedWhileLocked).toBe(true)
    expect(aError).toBeNull()
    const result = await paid.settled
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatchObject({ code: 'invalid_transition' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    expect((await inv(v)).reserved).toBe(0)
  })
})

/**
 * Ruling F-R4: every multi-row stock write locks inventory rows in ascending
 * variantId order, whatever the cart/line order, so a reserve and a release
 * over the same variants cannot deadlock. Deterministic: a blocker holds the
 * LOWER variant's row; the operation (given lines high-then-low) must block on
 * that row BEFORE touching the higher one, so the higher row is still free
 * (NOWAIT succeeds). In line order it would lock the higher row first and
 * NOWAIT would fail with 55P03.
 */
describe('stock writes lock inventory rows in variantId order', () => {
  async function pair() {
    const [a, b] = [await vid('BBS-STD'), await vid('ABE-1001')]
    return a < b ? { low: a, high: b } : { low: b, high: a }
  }

  async function assertLowLockedFirst(low: string, high: string, op: () => Promise<unknown>) {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    let signal!: () => void
    const held = new Promise<void>((r) => { signal = r })
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT variant_id FROM inventory WHERE variant_id = ${low} FOR UPDATE`
      signal()
      await gate
    }, { timeout: 15_000 })
    await held
    const running = op()
    try {
      // Wait until the operation is actually blocked on a row lock.
      for (let i = 0; ; i++) {
        const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`
        if (n > 0n) break
        if (i > 100) throw new Error('operation never blocked on the lower variant row')
        await new Promise((r) => setTimeout(r, 25))
      }
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT variant_id FROM inventory WHERE variant_id = ${high} FOR UPDATE NOWAIT`
      })
    } finally {
      open()
      await blocker
      await running
    }
  }

  it('placeOrder reserves in variantId order, not cart order', async () => {
    const { low, high } = await pair()
    await assertLowLockedFirst(low, high, () => placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: high, quantity: 1 }, { variantId: low, quantity: 1 }],
    }, BEFORE_QUOTE_TAX))
    expect((await inv(low)).reserved).toBe(1)
    expect((await inv(high)).reserved).toBe(1)
  })

  it('cancel releases in variantId order', async () => {
    const { low, high } = await pair()
    const o = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: high, quantity: 1 }, { variantId: low, quantity: 1 }],
    }, BEFORE_QUOTE_TAX)
    await assertLowLockedFirst(low, high, () => cancelOrder(o.id))
    expect((await inv(low)).reserved).toBe(0)
    expect((await inv(high)).reserved).toBe(0)
  })

  it('fulfillOrder decrements in variantId order', async () => {
    const { low, high } = await pair()
    const o = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: high, quantity: 1 }, { variantId: low, quantity: 1 }],
    }, BEFORE_QUOTE_TAX)
    await markOrderPaid(o.id)
    await assertLowLockedFirst(low, high, () => fulfillOrder(o.id))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'fulfilled' })
  })
})

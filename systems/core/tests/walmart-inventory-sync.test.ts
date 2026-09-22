import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import {
  computeAvailableToSell,
  pushInventoryForVariant,
  reconcileAllInventory,
  enqueueInventoryPush,
  registerInventoryHandlers,
} from '../src/channels/walmart/inventory.sync.js'
import { processDueJobs, clearHandlers } from '../src/channels/walmart/outbox.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

function recordingClient() {
  const calls: Array<{ method: string; path: string; opts?: any }> = []
  const client: WalmartClient = { request: async (method, path, opts) => { calls.push({ method, path, opts }); return {} } }
  return { client, calls }
}

async function seed(onHand: number, reserved: number, bufferPct?: number) {
  const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-9', priceCents: 1000 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-9-W', status: 'live', bufferPct } })
  return v
}

describe('computeAvailableToSell', () => {
  it('applies the default 10%-min-1 buffer', () => {
    expect(computeAvailableToSell(10, 0)).toBe(9)   // buffer ceil(1)=1
    expect(computeAvailableToSell(10, 3)).toBe(6)
    expect(computeAvailableToSell(2, 0)).toBe(1)    // min 1 buffer
    expect(computeAvailableToSell(1, 0)).toBe(0)
    expect(computeAvailableToSell(0, 0)).toBe(0)
    expect(computeAvailableToSell(25, 0)).toBe(22)  // ceil(2.5)=3
  })
  it('honors overrides including 0', () => {
    expect(computeAvailableToSell(10, 0, 20)).toBe(8)
    expect(computeAvailableToSell(10, 0, 0)).toBe(10)
    expect(computeAvailableToSell(5, 6)).toBe(0)    // never negative
  })

  // --- Boundary pins beyond the brief's own worked examples ---

  it('pins on-hand zero regardless of reserved (buffer is always 0 when on-hand is 0)', () => {
    expect(computeAvailableToSell(0, 0)).toBe(0)
    expect(computeAvailableToSell(0, 5)).toBe(0) // never goes negative even with reserved > on-hand=0
  })

  it('pins on-hand equal to reserved: fully committed stock, buffer pushes further negative, clamped to 0', () => {
    expect(computeAvailableToSell(5, 5)).toBe(0)
    expect(computeAvailableToSell(1, 1)).toBe(0)
  })

  it('pins the minimum-1 rule exactly at on-hand=1 (10% of 1 rounds to a fraction, floor would give 0)', () => {
    expect(computeAvailableToSell(1, 0)).toBe(0) // onHand 1 - buffer 1 (min-1) = 0
  })

  it('pins buffer rounding where 10% lands exactly on an integer (no min-1 needed to distinguish)', () => {
    expect(computeAvailableToSell(20, 0)).toBe(18) // 20*10/100 = 2.0 exactly, ceil(2)=2
    expect(computeAvailableToSell(100, 0)).toBe(90) // 100*10/100 = 10.0 exactly
  })

  it('pins buffer rounding where 10% does NOT land on an integer', () => {
    expect(computeAvailableToSell(11, 0)).toBe(9) // 11*10/100=1.1, ceil=2 -> 11-0-2=9
    expect(computeAvailableToSell(25, 0)).toBe(22) // 25*10/100=2.5, ceil=3
  })

  it('pins a bufferPct override of 0: no buffer at all, even with the min-1 rule in play elsewhere', () => {
    expect(computeAvailableToSell(10, 0, 0)).toBe(10)
    expect(computeAvailableToSell(1, 0, 0)).toBe(1) // would be 0 under the default 10%-min-1 buffer
  })

  it('pins a bufferPct override of 100: the entire on-hand is buffered away', () => {
    expect(computeAvailableToSell(10, 0, 100)).toBe(0)
    expect(computeAvailableToSell(1, 0, 100)).toBe(0)
  })

  it('treats null bufferPct the same as undefined (falls back to the 10% default)', () => {
    expect(computeAvailableToSell(10, 0, null as any)).toBe(9)
  })
})

describe('inventory push', () => {
  beforeEach(resetDb)
  afterAll(() => prisma.$disconnect())

  it('pushes ATS for a live listing and records last-pushed state', async () => {
    const v = await seed(10, 2)
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([{ method: 'PUT', path: '/v3/inventory', opts: { query: { sku: 'ABE-9-W' }, body: { sku: 'ABE-9-W', quantity: { unit: 'EACH', amount: 7 } } } }])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedQty).toBe(7)
    expect(listing.lastSyncedAt).not.toBeNull()
  })

  it('is a no-op without a pushable listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'x', name: 'X', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-X', priceCents: 100 } })
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([])
  })

  it('is a no-op for a draft or retired listing (only live/submitted are pushable)', async () => {
    const p = await prisma.product.create({ data: { slug: 'd', name: 'D', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-D', priceCents: 100 } })
    await prisma.inventory.create({ data: { variantId: v.id, onHand: 10, reserved: 0 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-D-W', status: 'draft' } })
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([])
  })

  it('pushes for a submitted listing too, not just live', async () => {
    const p = await prisma.product.create({ data: { slug: 'sub', name: 'Sub', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SUB', priceCents: 100 } })
    await prisma.inventory.create({ data: { variantId: v.id, onHand: 10, reserved: 0 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SUB-W', status: 'submitted' } })
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toHaveLength(1)
  })

  it('reconcileAllInventory sweeps all live listings', async () => {
    await seed(10, 0)
    const { client, calls } = recordingClient()
    const r = await reconcileAllInventory(client)
    expect(r.pushed).toBe(1)
    expect(calls.length).toBe(1)
  })

  it('reconcileAllInventory does not sweep a submitted or draft listing (only live)', async () => {
    const p = await prisma.product.create({ data: { slug: 'sub2', name: 'Sub2', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SUB2', priceCents: 100 } })
    await prisma.inventory.create({ data: { variantId: v.id, onHand: 10, reserved: 0 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SUB2-W', status: 'submitted' } })
    const { client, calls } = recordingClient()
    const r = await reconcileAllInventory(client)
    expect(r.pushed).toBe(0)
    expect(calls.length).toBe(0)
  })
})

describe('enqueueInventoryPush', () => {
  beforeEach(async () => {
    await resetDb()
    clearHandlers()
  })

  it('is a no-op when the variant has no channel listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'nolisting', name: 'NoListing', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-NL', priceCents: 100 } })
    await enqueueInventoryPush(v.id)
    expect(await prisma.channelJob.count()).toBe(0)
  })

  it('enqueues a walmart_push_inventory job keyed inv:<variantId> when a listing exists', async () => {
    const v = await seed(10, 0)
    await enqueueInventoryPush(v.id)
    const job = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_push_inventory' } })
    expect(job.dedupeKey).toBe(`inv:${v.id}`)
    expect(job.payload).toEqual({ variantId: v.id })
  })

  it('collapses a burst via dedupeKey, but allows a fresh enqueue once the prior push job has completed', async () => {
    const v = await seed(10, 0)
    await enqueueInventoryPush(v.id)
    await enqueueInventoryPush(v.id) // same dedupeKey while pending -- collapsed
    expect(await prisma.channelJob.count({ where: { type: 'walmart_push_inventory' } })).toBe(1)

    registerInventoryHandlers(recordingClient().client)
    await processDueJobs()
    expect((await prisma.channelJob.findFirstOrThrow()).status).toBe('done')

    await enqueueInventoryPush(v.id) // recurring key released now that the job is done
    // enqueueJob's recovery nulls out the completed job's dedupeKey and inserts
    // a fresh row under the key rather than reusing the old row -- so there are
    // now 2 rows of this type (1 done with dedupeKey: null, 1 pending under the
    // key), which is exactly the "release, don't reuse" behaviour Task 4 added.
    expect(await prisma.channelJob.count({ where: { type: 'walmart_push_inventory' } })).toBe(2)
    const job = await prisma.channelJob.findFirstOrThrow({ where: { dedupeKey: `inv:${v.id}` } })
    expect(job.status).toBe('pending')
  })

  it('registerInventoryHandlers wires walmart_push_inventory through processDueJobs end-to-end', async () => {
    const v = await seed(10, 2) // ATS = 10 - 2 - buffer(ceil(1)=1) = 7
    const { client, calls } = recordingClient()
    registerInventoryHandlers(client)
    await enqueueInventoryPush(v.id)
    const r = await processDueJobs()
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(calls).toEqual([{ method: 'PUT', path: '/v3/inventory', opts: { query: { sku: 'ABE-9-W' }, body: { sku: 'ABE-9-W', quantity: { unit: 'EACH', amount: 7 } } } }])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedQty).toBe(7)
  })
})

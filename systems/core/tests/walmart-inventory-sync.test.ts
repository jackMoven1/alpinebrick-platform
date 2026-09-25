import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import {
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

async function seed(onHand: number, reserved: number, walmartAllocation: number | null = null) {
  const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-9', priceCents: 1000 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved, walmartAllocation } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-9-W', status: 'live' } })
  return v
}

// The 10%-min-1 buffer was removed 2026-09-24 (spec §5.1 rule 5): it told
// Walmart 0 for every one-off. The figure pushed is walmartSellable, whose
// unit tests live in allocation.test.ts.

describe('inventory push', () => {
  beforeEach(resetDb)
  afterAll(() => prisma.$disconnect())

  it('pushes ATS for a live listing and records last-pushed state', async () => {
    const v = await seed(10, 2)
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([{ method: 'PUT', path: '/v3/inventory', opts: { query: { sku: 'ABE-9-W' }, body: { sku: 'ABE-9-W', quantity: { unit: 'EACH', amount: 8 } } } }])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedQty).toBe(8)
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
    expect(r).toEqual({ pushed: 1, failed: 0 })
    expect(calls.length).toBe(1)
  })

  it('reconcileAllInventory does not sweep a submitted or draft listing (only live)', async () => {
    const p = await prisma.product.create({ data: { slug: 'sub2', name: 'Sub2', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SUB2', priceCents: 100 } })
    await prisma.inventory.create({ data: { variantId: v.id, onHand: 10, reserved: 0 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SUB2-W', status: 'submitted' } })
    const { client, calls } = recordingClient()
    const r = await reconcileAllInventory(client)
    expect(r).toEqual({ pushed: 0, failed: 0 })
    expect(calls.length).toBe(0)
  })

  // Final fix wave B3: one listing throwing used to abort the whole sweep,
  // so every listing after it went un-reconciled for another hour.
  it('reconcileAllInventory isolates a failing listing, keeps going, and does not count it as pushed', async () => {
    const skus = ['ABE-R1', 'ABE-R2', 'ABE-R3']
    for (const [i, sku] of skus.entries()) {
      const p = await prisma.product.create({ data: { slug: `r${i}`, name: `R${i}`, productType: 'own_designed', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku, priceCents: 100 } })
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 10, reserved: 0 } })
      await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: `${sku}-W`, status: 'live' } })
    }
    const pushedSkus: string[] = []
    const client: WalmartClient = {
      request: async (_m, _path, opts: any) => {
        if (opts?.query?.sku === 'ABE-R1-W') throw new Error('walmart 500 for R1')
        pushedSkus.push(opts?.query?.sku)
        return {}
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await reconcileAllInventory(client)
      expect(r).toEqual({ pushed: 2, failed: 1 })
      expect(pushedSkus.sort()).toEqual(['ABE-R2-W', 'ABE-R3-W'])
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0].map(String).join(' ')).toContain('walmart 500 for R1')
    } finally {
      errorSpy.mockRestore()
    }
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
    const v = await seed(10, 2) // sellable = 10 - 2, no buffer = 8
    const { client, calls } = recordingClient()
    registerInventoryHandlers(client)
    await enqueueInventoryPush(v.id)
    const r = await processDueJobs()
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(calls).toEqual([{ method: 'PUT', path: '/v3/inventory', opts: { query: { sku: 'ABE-9-W' }, body: { sku: 'ABE-9-W', quantity: { unit: 'EACH', amount: 8 } } } }])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedQty).toBe(8)
  })
})

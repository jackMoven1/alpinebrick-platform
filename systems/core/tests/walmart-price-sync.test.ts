import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { pushPriceForVariant, enqueuePricePush, registerPriceHandlers } from '../src/channels/walmart/price.sync.js'
import { processDueJobs, clearHandlers } from '../src/channels/walmart/outbox.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

function recordingClient() {
  const calls: Array<{ method: string; path: string; opts?: any }> = []
  const client: WalmartClient = { request: async (method, path, opts) => { calls.push({ method, path, opts }); return {} } }
  return { client, calls }
}

describe('walmart price push', () => {
  beforeEach(resetDb)
  afterAll(() => prisma.$disconnect())

  it('pushes the override price when set, else the catalog price', async () => {
    const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-1', priceCents: 4999 } })
    const listing = await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-1-W', status: 'live' } })
    const { client, calls } = recordingClient()

    await pushPriceForVariant(v.id, client)
    expect(calls[0].opts.body.pricing[0].currentPrice.amount).toBe(49.99)
    // Wire format check: assert the actual serialised string, not just the JS number --
    // a test comparing numbers can pass while the JSON Walmart receives is wrong.
    expect(JSON.stringify(calls[0].opts.body)).toBe(
      JSON.stringify({ sku: 'ABE-1-W', pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: 49.99 } }] }),
    )
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).lastPushedPriceCents).toBe(4999)

    await prisma.channelListing.update({ where: { id: listing.id }, data: { priceOverrideCents: 5499 } })
    await pushPriceForVariant(v.id, client)
    expect(calls[1].opts.body.pricing[0].currentPrice.amount).toBe(54.99)
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).lastPushedPriceCents).toBe(5499)
  })

  it('no-ops without a pushable listing (no listing at all)', async () => {
    const p = await prisma.product.create({ data: { slug: 'x', name: 'X', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-2', priceCents: 100 } })
    const { client, calls } = recordingClient()
    await pushPriceForVariant(v.id, client)
    expect(calls).toEqual([])
  })

  it('no-ops for a draft or retired listing (only live/submitted are pushable)', async () => {
    const p = await prisma.product.create({ data: { slug: 'd', name: 'D', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-D', priceCents: 100 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-D-W', status: 'draft' } })
    const { client, calls } = recordingClient()
    await pushPriceForVariant(v.id, client)
    expect(calls).toEqual([])

    const p2 = await prisma.product.create({ data: { slug: 'r', name: 'R', productType: 'own_designed' } })
    const v2 = await prisma.variant.create({ data: { productId: p2.id, sku: 'ABE-R', priceCents: 100 } })
    await prisma.channelListing.create({ data: { variantId: v2.id, walmartSku: 'ABE-R-W', status: 'retired' } })
    await pushPriceForVariant(v2.id, client)
    expect(calls).toEqual([])
  })

  it('no-ops for a rejected listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'rej', name: 'Rej', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-REJ', priceCents: 100 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-REJ-W', status: 'rejected' } })
    const { client, calls } = recordingClient()
    await pushPriceForVariant(v.id, client)
    expect(calls).toEqual([])
  })

  it('pushes for a submitted listing too, not just live', async () => {
    const p = await prisma.product.create({ data: { slug: 'sub', name: 'Sub', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SUB', priceCents: 2500 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SUB-W', status: 'submitted' } })
    const { client, calls } = recordingClient()
    await pushPriceForVariant(v.id, client)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.body.pricing[0].currentPrice.amount).toBe(25)
  })

  // --- The money boundary: cents -> decimal dollars, asserted on the wire string ---

  it('serialises tricky cent values correctly on the wire, not just as JS numbers', async () => {
    const cases: Array<{ cents: number; amount: number; label: string }> = [
      { cents: 1, amount: 0.01, label: 'a cent, under a dollar' },
      { cents: 7, amount: 0.07, label: 'non-round cents under a dollar' },
      { cents: 33, amount: 0.33, label: 'non-round cents' },
      { cents: 4999, amount: 49.99, label: 'ordinary retail price' },
      { cents: 0, amount: 0, label: 'exactly zero' },
      { cents: 999999999, amount: 9999999.99, label: 'a large price' },
    ]
    for (const { cents, amount, label } of cases) {
      const p = await prisma.product.create({ data: { slug: `z-${cents}`, name: 'Z', productType: 'own_designed' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku: `Z-${cents}`, priceCents: cents } })
      await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: `Z-${cents}-W`, status: 'live' } })
      const { client, calls } = recordingClient()
      await pushPriceForVariant(v.id, client)
      const body = calls[0].opts.body as any
      expect(body.pricing[0].currentPrice.amount, label).toBe(amount)
      // The load-bearing assertion: the exact JSON text sent over the wire.
      expect(JSON.stringify(body.pricing[0].currentPrice), label).toBe(JSON.stringify({ currency: 'USD', amount }))
    }
  })
})

describe('enqueuePricePush', () => {
  beforeEach(async () => {
    await resetDb()
    clearHandlers()
  })

  it('is a no-op when the variant has no channel listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'nolisting', name: 'NoListing', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-NL', priceCents: 100 } })
    await enqueuePricePush(v.id)
    expect(await prisma.channelJob.count()).toBe(0)
  })

  it('enqueues a walmart_push_price job keyed price:<variantId> when a listing exists', async () => {
    const p = await prisma.product.create({ data: { slug: 'ep', name: 'EP', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-EP', priceCents: 999 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-EP-W', status: 'live' } })
    await enqueuePricePush(v.id)
    const job = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_push_price' } })
    expect(job.dedupeKey).toBe(`price:${v.id}`)
    expect(job.payload).toEqual({ variantId: v.id })
  })

  it('collapses a burst via dedupeKey, but allows a fresh enqueue once the prior push job has completed', async () => {
    const p = await prisma.product.create({ data: { slug: 'burst', name: 'Burst', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-BURST', priceCents: 999 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-BURST-W', status: 'live' } })

    await enqueuePricePush(v.id)
    await enqueuePricePush(v.id) // same dedupeKey while pending -- collapsed
    expect(await prisma.channelJob.count({ where: { type: 'walmart_push_price' } })).toBe(1)

    registerPriceHandlers(recordingClient().client)
    await processDueJobs()
    expect((await prisma.channelJob.findFirstOrThrow()).status).toBe('done')

    await enqueuePricePush(v.id) // recurring key released now that the job is done
    expect(await prisma.channelJob.count({ where: { type: 'walmart_push_price' } })).toBe(2)
    const job = await prisma.channelJob.findFirstOrThrow({ where: { dedupeKey: `price:${v.id}` } })
    expect(job.status).toBe('pending')
  })

  it('registerPriceHandlers wires walmart_push_price through processDueJobs end-to-end', async () => {
    const p = await prisma.product.create({ data: { slug: 'e2e', name: 'E2E', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-E2E', priceCents: 1234 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-E2E-W', status: 'live' } })
    const { client, calls } = recordingClient()
    registerPriceHandlers(client)
    await enqueuePricePush(v.id)
    const r = await processDueJobs()
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(calls).toEqual([
      { method: 'PUT', path: '/v3/price', opts: { body: { sku: 'ABE-E2E-W', pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: 12.34 } }] } } },
    ])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedPriceCents).toBe(1234)
  })
})

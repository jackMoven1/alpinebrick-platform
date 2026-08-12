import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

describe('walmart channel schema', () => {
  beforeEach(resetDb)

  it('creates a walmart-channel order with external id', async () => {
    const o = await prisma.order.create({
      data: {
        email: 'walmart-customer@channel.local', shipToState: 'MI',
        subtotalCents: 9998, taxCents: 600, totalCents: 10598,
        taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        status: 'paid', channel: 'walmart', externalOrderId: 'PO-1001',
      },
    })
    expect(o.channel).toBe('walmart')
    await expect(prisma.order.create({
      data: {
        email: 'x@y.z', shipToState: 'MI', subtotalCents: 1, taxCents: 0, totalCents: 1,
        taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        channel: 'walmart', externalOrderId: 'PO-1001',
      },
    })).rejects.toThrow() // unique externalOrderId
  })

  it('defaults channel to storefront', async () => {
    const o = await prisma.order.create({
      data: { email: 'a@b.c', shipToState: 'MI', subtotalCents: 1, taxCents: 0, totalCents: 1, taxRateBps: 600, taxJurisdiction: 'MI' },
    })
    expect(o.channel).toBe('storefront')
    expect(o.externalOrderId).toBeNull()
  })

  it('enforces ChannelEvent idempotency key and creates channel tables', async () => {
    const p = await prisma.product.create({ data: { slug: 'p1', name: 'P1', productType: 'own_designed', status: 'published' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-1', priceCents: 4999 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-1-W' } })
    await prisma.channelJob.create({ data: { type: 'walmart_push_inventory', payload: { variantId: v.id } } })
    await prisma.channelFeed.create({ data: { feedId: 'F1', type: 'item', status: 'submitted' } })
    await prisma.channelSettlement.create({ data: { reportDate: new Date(), externalOrderId: 'PO-1', amountCents: 100, feeCents: 15, raw: {} } })
    await prisma.channelEvent.create({ data: { source: 'webhook', externalId: 'PO-1', eventType: 'order_created' } })
    await expect(prisma.channelEvent.create({ data: { source: 'poll', externalId: 'PO-1', eventType: 'order_created' } }))
      .rejects.toThrow()
  })
})

import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createListing, submitItemFeed, checkFeedStatus } from '../src/channels/walmart/listings.service.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

type ImageSpec = { storageKey?: string; status?: 'pending' | 'ready'; position: number }

// Mirrors catalog.service.ts's real Image shape (Product.images is a real
// table since migration 20260813153802_add_images_table -- there is no
// `url` field, and a `pending` image must never be resolved for a customer
// or a marketplace).
async function seedVariant(
  opts: { status?: 'draft' | 'published'; images?: ImageSpec[] } = {},
) {
  const status = opts.status ?? 'published'
  const images = opts.images ?? [{ storageKey: `img/${randomUUID()}.jpg`, status: 'ready' as const, position: 0 }]
  const p = await prisma.product.create({
    data: {
      slug: `castle-${randomUUID()}`,
      name: 'Castle',
      description: 'A castle set',
      status,
      productType: 'own_designed',
      images: {
        create: images.map((img) => ({
          storageKey: img.storageKey ?? `img/${randomUUID()}.jpg`,
          alt: '',
          position: img.position,
          width: 900,
          height: 720,
          contentType: 'image/svg+xml',
          byteSize: 0,
          status: img.status ?? 'ready',
        })),
      },
    },
  })
  return prisma.variant.create({ data: { productId: p.id, sku: `ABE-${randomUUID()}`, priceCents: 4999 } })
}

let savedAssetBase: string | undefined

describe('walmart listings', () => {
  beforeEach(async () => {
    await resetDb()
    savedAssetBase = process.env.ASSET_PUBLIC_BASE_URL
    process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test'
  })

  afterEach(() => {
    process.env.ASSET_PUBLIC_BASE_URL = savedAssetBase
  })

  it('creates a draft listing for a published product only', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'ABE-C-W')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('draft')
    const vDraft = await seedVariant({ status: 'draft' })
    await expect(createListing(vDraft.id, 'ABE-D-W')).rejects.toMatchObject({ code: 'not_published' })
  })

  it('submits an item feed and tracks status to live', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'ABE-C-W')
    const calls: any[] = []
    const client: WalmartClient = {
      request: async (method, path) => {
        calls.push({ method, path })
        if (path.startsWith('/v3/feeds') && method === 'POST') return { feedId: 'FEED-1' }
        return { feedStatus: 'PROCESSED' }
      },
    }
    const { feedId } = await submitItemFeed([l.id], client)
    expect(feedId).toBe('FEED-1')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('submitted')
    expect(await checkFeedStatus('FEED-1', client)).toBe('processed')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('live')
    expect((await prisma.channelFeed.findUniqueOrThrow({ where: { feedId: 'FEED-1' } })).status).toBe('processed')
  })

  it('marks listings rejected on feed error and stores walmart errors', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'ABE-C-W')
    const client: WalmartClient = {
      request: async (method, path) =>
        method === 'POST'
          ? { feedId: 'FEED-2' }
          : {
              feedStatus: 'ERROR',
              itemDetails: {
                itemIngestionStatus: [
                  { sku: 'ABE-C-W', ingestionErrors: { ingestionError: [{ description: 'missing attribute' }] } },
                ],
              },
            },
    }
    await submitItemFeed([l.id], client)
    expect(await checkFeedStatus('FEED-2', client)).toBe('error')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('rejected')
    const feed = await prisma.channelFeed.findUniqueOrThrow({ where: { feedId: 'FEED-2' } })
    expect(JSON.stringify(feed.errors)).toContain('missing attribute')
  })

  // The failure mode this task exists to prevent: Walmart can report the
  // FEED as PROCESSED while individual ITEMS within it still failed
  // ingestion. A status check that only looks at feedStatus would mark the
  // failed SKU live right alongside the ones that actually succeeded.
  it('marks only the failed item rejected when a processed feed has mixed per-item results', async () => {
    const vGood = await seedVariant()
    const vBad = await seedVariant()
    const lGood = await createListing(vGood.id, 'ABE-GOOD-W')
    const lBad = await createListing(vBad.id, 'ABE-BAD-W')
    const client: WalmartClient = {
      request: async (method) =>
        method === 'POST'
          ? { feedId: 'FEED-3' }
          : {
              feedStatus: 'PROCESSED',
              itemDetails: {
                itemIngestionStatus: [
                  { sku: 'ABE-GOOD-W', ingestionStatus: 'SUCCESS' },
                  { sku: 'ABE-BAD-W', ingestionErrors: { ingestionError: [{ description: 'invalid price' }] } },
                ],
              },
            },
    }
    await submitItemFeed([lGood.id, lBad.id], client)
    expect(await checkFeedStatus('FEED-3', client)).toBe('processed')

    const good = await prisma.channelListing.findUniqueOrThrow({ where: { id: lGood.id } })
    expect(good.status).toBe('live')

    const bad = await prisma.channelListing.findUniqueOrThrow({ where: { id: lBad.id } })
    expect(bad.status).toBe('rejected')
    expect(bad.status).not.toBe('live')

    const feed = await prisma.channelFeed.findUniqueOrThrow({ where: { feedId: 'FEED-3' } })
    expect(feed.status).toBe('processed')
    expect(JSON.stringify(feed.errors)).toContain('invalid price')
  })

  it('resolves only ready images, in position order, as absolute URLs', async () => {
    const v = await seedVariant({
      images: [
        { storageKey: 'img/pending.jpg', status: 'pending', position: 0 },
        { storageKey: 'img/second.jpg', status: 'ready', position: 2 },
        { storageKey: 'img/first.jpg', status: 'ready', position: 1 },
      ],
    })
    const l = await createListing(v.id, 'ABE-C-W')
    let body: any
    const client: WalmartClient = {
      request: async (method, _path, opts) => {
        if (method === 'POST') {
          body = opts?.body
          return { feedId: 'FEED-IMG' }
        }
        return { feedStatus: 'PROCESSED' }
      },
    }
    await submitItemFeed([l.id], client)
    const item = (body as any).MPItem[0]
    expect(item.Visible.Toys.mainImageUrl).toBe('https://cdn.test/img/first.jpg')
    expect(item.Visible.Toys.productSecondaryImageURL).toEqual(['https://cdn.test/img/second.jpg'])
  })

  it('refuses to submit a product with no ready image', async () => {
    const v = await seedVariant({ images: [{ storageKey: 'img/pending.jpg', status: 'pending', position: 0 }] })
    const l = await createListing(v.id, 'ABE-C-W')
    await expect(submitItemFeed([l.id])).rejects.toMatchObject({ code: 'missing_image' })
  })

  it('refuses to submit when the resolved image URL would not be absolute', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'ABE-C-W')
    process.env.ASSET_PUBLIC_BASE_URL = ''
    await expect(submitItemFeed([l.id])).rejects.toMatchObject({ code: 'asset_base_url_unset' })
  })
})

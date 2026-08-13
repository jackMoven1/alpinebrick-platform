import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

async function makeProduct(slug: string) {
  return prisma.product.create({
    data: { slug, name: slug, productType: 'resale', status: 'published' },
  })
}

describe('Image table', () => {
  beforeAll(async () => { await resetDb() })
  afterAll(async () => { await prisma.$disconnect() })

  it('persists an image with a storage key and dimensions', async () => {
    const p = await makeProduct('img-fixture-1')
    const img = await prisma.image.create({
      data: {
        productId: p.id,
        storageKey: `products/${p.id}/abc/original.jpg`,
        alt: 'Front view',
        position: 0,
        width: 900,
        height: 720,
        contentType: 'image/jpeg',
        byteSize: 12345,
        status: 'ready',
      },
    })
    expect(img.storageKey).toBe(`products/${p.id}/abc/original.jpg`)
    expect(img.width).toBe(900)
    expect(img.status).toBe('ready')
  })

  it('defaults alt to empty and status to pending', async () => {
    const p = await makeProduct('img-fixture-2')
    const img = await prisma.image.create({
      data: {
        productId: p.id, storageKey: `products/${p.id}/d/original.jpg`,
        position: 0, width: 10, height: 10, contentType: 'image/jpeg', byteSize: 1,
      },
    })
    expect(img.alt).toBe('')
    expect(img.status).toBe('pending')
  })

  it('rejects two images sharing a storage key', async () => {
    const p = await makeProduct('img-fixture-3')
    const key = `products/${p.id}/dup/original.jpg`
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    await prisma.image.create({ data: { ...base, storageKey: key, position: 0 } })
    await expect(
      prisma.image.create({ data: { ...base, storageKey: key, position: 1 } }),
    ).rejects.toThrow()
  })

  it('rejects two images claiming the same position on one product', async () => {
    const p = await makeProduct('img-fixture-4')
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/a/original.jpg`, position: 0 } })
    await expect(
      prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/b/original.jpg`, position: 0 } }),
    ).rejects.toThrow()
  })

  // The single easiest thing to get wrong in the migration. A non-deferrable
  // unique constraint is checked after EACH statement, so the first UPDATE
  // collides with the row that has not moved yet and reordering is impossible.
  it('allows two images to swap positions inside one transaction', async () => {
    const p = await makeProduct('img-fixture-5')
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    const a = await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/s1/original.jpg`, position: 0 } })
    const b = await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/s2/original.jpg`, position: 1 } })

    await prisma.$transaction([
      prisma.image.update({ where: { id: a.id }, data: { position: 1 } }),
      prisma.image.update({ where: { id: b.id }, data: { position: 0 } }),
    ])

    expect((await prisma.image.findUniqueOrThrow({ where: { id: a.id } })).position).toBe(1)
    expect((await prisma.image.findUniqueOrThrow({ where: { id: b.id } })).position).toBe(0)
  })

  it('cascade-deletes images when the product is deleted', async () => {
    const p = await makeProduct('img-fixture-6')
    await prisma.image.create({
      data: {
        productId: p.id, storageKey: `products/${p.id}/c/original.jpg`,
        position: 0, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1,
      },
    })
    await prisma.product.delete({ where: { id: p.id } })
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'
import {
  buildStorageKey, requestUpload, confirmUpload, reorderImages,
  deleteImage, sweepPendingImages, listReadyImages, ImageError,
} from '../src/assets/image.service.js'

function fakePort(objects: Record<string, StoredObject> = {}): AssetStoragePort {
  return {
    createUploadTarget: vi.fn(async (key: string) => ({
      uploadUrl: `https://upload.test/${key}`,
      expiresAt: new Date(Date.now() + 60_000),
    })),
    stat: vi.fn(async (key: string) => objects[key] ?? null),
    delete: vi.fn(async () => {}),
  }
}

const OBJ: StoredObject = { width: 1600, height: 1200, byteSize: 5000, contentType: 'image/jpeg' }

async function makeProduct(slug = 'svc-product') {
  return prisma.product.create({
    data: { slug, name: slug, productType: 'resale', status: 'published' },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('buildStorageKey', () => {
  it('uses the documented format and maps the content type to an extension', () => {
    expect(buildStorageKey('p1', 'i1', 'image/jpeg')).toBe('products/p1/i1/original.jpg')
    expect(buildStorageKey('p1', 'i1', 'image/png')).toBe('products/p1/i1/original.png')
    expect(buildStorageKey('p1', 'i1', 'image/webp')).toBe('products/p1/i1/original.webp')
  })

  it('rejects a content type that is not an accepted image format', () => {
    expect(() => buildStorageKey('p1', 'i1', 'application/pdf')).toThrow(ImageError)
  })
})

describe('requestUpload', () => {
  it('reserves a pending row and returns an upload target', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })

    expect(r.storageKey).toBe(`products/${p.id}/${r.imageId}/original.jpg`)
    expect(r.uploadUrl).toContain(r.storageKey)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
  })

  it('appends at the end of the existing positions', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const rowA = await prisma.image.findUniqueOrThrow({ where: { id: a.imageId } })
    const rowB = await prisma.image.findUniqueOrThrow({ where: { id: b.imageId } })
    expect(rowA.position).toBe(0)
    expect(rowB.position).toBe(1)
  })

  it('rejects an unknown product', async () => {
    await expect(
      requestUpload(fakePort(), { productId: 'nope', contentType: 'image/jpeg', byteSize: 1 }),
    ).rejects.toThrow(ImageError)
  })

  it('rejects a file over the size ceiling', async () => {
    const p = await makeProduct()
    await expect(
      requestUpload(fakePort(), { productId: p.id, contentType: 'image/jpeg', byteSize: 50_000_000 }),
    ).rejects.toThrow(ImageError)
  })

  it('rejects an unsupported content type before writing any row', async () => {
    const p = await makeProduct()
    await expect(
      requestUpload(fakePort(), { productId: p.id, contentType: 'application/pdf', byteSize: 10 }),
    ).rejects.toThrow(ImageError)
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})

describe('confirmUpload', () => {
  it('reads dimensions FROM STORAGE and marks the row ready', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    const withObject = fakePort({ [r.storageKey]: OBJ })

    const dto = await confirmUpload(withObject, r.imageId)
    expect(dto.width).toBe(1600)
    expect(dto.height).toBe(1200)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('ready')
    expect(row.byteSize).toBe(5000)
  })

  // The whole reason `pending` exists.
  it('refuses to confirm when the bytes never arrived', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    await expect(confirmUpload(port, r.imageId)).rejects.toThrow(ImageError)
    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
  })

  it('rejects an unknown image id', async () => {
    await expect(confirmUpload(fakePort(), 'nope')).rejects.toThrow(ImageError)
  })
})

describe('listReadyImages', () => {
  it('returns ready images in position order and excludes pending ones', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }) // left pending

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([a.imageId, b.imageId])
  })
})

describe('reorderImages', () => {
  it('swaps two images', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)

    await reorderImages(p.id, [b.imageId, a.imageId])

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([b.imageId, a.imageId])
  })

  it('rejects an ordering that omits an image', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await expect(reorderImages(p.id, [])).rejects.toThrow(ImageError)
  })
})

describe('deleteImage', () => {
  it('removes the row, deletes the object, and closes the position gap', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)

    const delPort = fakePort()
    await deleteImage(delPort, a.imageId)

    expect(delPort.delete).toHaveBeenCalledWith(a.storageKey)
    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([b.imageId])
    expect(list[0]!.position).toBe(0)
  })
})

describe('sweepPendingImages', () => {
  it('removes stale pending rows and leaves ready ones alone', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const stale = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const good = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [good.storageKey]: OBJ }), good.imageId)

    // Age the pending row behind the service's back.
    await prisma.image.update({
      where: { id: stale.imageId },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    })

    const removed = await sweepPendingImages(fakePort(), new Date(Date.now() - 24 * 3600 * 1000))
    expect(removed).toBe(1)
    expect(await prisma.image.findUnique({ where: { id: stale.imageId } })).toBeNull()
    expect(await prisma.image.findUnique({ where: { id: good.imageId } })).not.toBeNull()
  })
})

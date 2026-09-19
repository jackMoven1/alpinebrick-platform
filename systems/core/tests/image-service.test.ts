import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'
import {
  buildStorageKey, requestUpload, confirmUpload, reorderImages,
  deleteImage, sweepPendingImages, listReadyImages, updateImageAlt, ImageError,
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

let actorId: string

beforeEach(async () => {
  await resetDb()
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  actorId = actor.id
})
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
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 }, actorId)

    expect(r.storageKey).toBe(`products/${p.id}/${r.imageId}/original.jpg`)
    expect(r.uploadUrl).toContain(r.storageKey)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
  })

  // The row creation and the audit write are both pure database work, done in
  // one transaction -- the external port.createUploadTarget call happens only
  // after that transaction has committed (see the confirmUpload analog below).
  it('audits the request with the actor and the storage key', async () => {
    const p = await makeProduct()
    const r = await requestUpload(fakePort(), { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 }, actorId)
    const rows = await prisma.auditLog.findMany({ where: { action: 'image.upload.request' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actorId)
    expect(rows[0].target).toBe(`image:${r.imageId}`)
    expect((rows[0].after as any).storageKey).toBe(r.storageKey)
  })

  it('appends at the end of the existing positions', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const rowA = await prisma.image.findUniqueOrThrow({ where: { id: a.imageId } })
    const rowB = await prisma.image.findUniqueOrThrow({ where: { id: b.imageId } })
    expect(rowA.position).toBe(0)
    expect(rowB.position).toBe(1)
  })

  it('rejects an unknown product', async () => {
    await expect(
      requestUpload(fakePort(), { productId: 'nope', contentType: 'image/jpeg', byteSize: 1 }, actorId),
    ).rejects.toThrow(ImageError)
  })

  it('rejects a file over the size ceiling', async () => {
    const p = await makeProduct()
    await expect(
      requestUpload(fakePort(), { productId: p.id, contentType: 'image/jpeg', byteSize: 50_000_000 }, actorId),
    ).rejects.toThrow(ImageError)
  })

  it('rejects an unsupported content type before writing any row', async () => {
    const p = await makeProduct()
    await expect(
      requestUpload(fakePort(), { productId: p.id, contentType: 'application/pdf', byteSize: 10 }, actorId),
    ).rejects.toThrow(ImageError)
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})

describe('confirmUpload', () => {
  it('reads dimensions FROM STORAGE and marks the row ready', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 }, actorId)
    const withObject = fakePort({ [r.storageKey]: OBJ })

    const dto = await confirmUpload(withObject, r.imageId, actorId)
    expect(dto.width).toBe(1600)
    expect(dto.height).toBe(1200)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('ready')
    expect(row.byteSize).toBe(5000)
  })

  // port.stat() is storage I/O and runs BEFORE any transaction opens; the
  // transaction wraps only the row update and the audit write, which run
  // together. So the audit row must exist only on the success path.
  it('audits the confirmation only after storage is verified', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 }, actorId)
    await confirmUpload(fakePort({ [r.storageKey]: OBJ }), r.imageId, actorId)

    const rows = await prisma.auditLog.findMany({ where: { action: 'image.upload.confirm' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actorId)
    expect(rows[0].target).toBe(`image:${r.imageId}`)
    expect((rows[0].before as any).status).toBe('pending')
    expect((rows[0].after as any).status).toBe('ready')
  })

  // The whole reason `pending` exists.
  it('refuses to confirm when the bytes never arrived', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 }, actorId)
    await expect(confirmUpload(port, r.imageId, actorId)).rejects.toThrow(ImageError)
    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
    // stat() failed before any transaction opened, so no audit row either.
    expect(await prisma.auditLog.count({ where: { action: 'image.upload.confirm' } })).toBe(0)
  })

  it('rejects an unknown image id', async () => {
    await expect(confirmUpload(fakePort(), 'nope', actorId)).rejects.toThrow(ImageError)
  })
})

describe('updateImageAlt', () => {
  it('updates the alt text and audits before/after', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [r.storageKey]: OBJ }), r.imageId, actorId)

    const dto = await updateImageAlt(r.imageId, 'Front three-quarter view', actorId)
    expect(dto.alt).toBe('Front three-quarter view')

    const rows = await prisma.auditLog.findMany({ where: { action: 'image.alt' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actorId)
    expect(rows[0].target).toBe(`image:${r.imageId}`)
    expect((rows[0].before as any).alt).toBe('')
    expect((rows[0].after as any).alt).toBe('Front three-quarter view')
  })

  it('rejects an unknown image id and writes no audit row', async () => {
    await expect(updateImageAlt('nope', 'x', actorId)).rejects.toThrow(ImageError)
    expect(await prisma.auditLog.count({ where: { action: 'image.alt' } })).toBe(0)
  })
})

describe('listReadyImages', () => {
  it('returns ready images in position order and excludes pending ones', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId, actorId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId, actorId)
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId) // left pending

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([a.imageId, b.imageId])
  })
})

describe('reorderImages', () => {
  it('swaps two images', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId, actorId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId, actorId)

    await reorderImages(p.id, [b.imageId, a.imageId], actorId)

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([b.imageId, a.imageId])
  })

  it('rejects an ordering that omits an image', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId, actorId)
    await expect(reorderImages(p.id, [], actorId)).rejects.toThrow(ImageError)
  })
})

describe('deleteImage', () => {
  it('removes the row, deletes the object, and closes the position gap', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId, actorId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId, actorId)

    const delPort = fakePort()
    await deleteImage(delPort, a.imageId, actorId)

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
    const stale = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const good = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await confirmUpload(fakePort({ [good.storageKey]: OBJ }), good.imageId, actorId)

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

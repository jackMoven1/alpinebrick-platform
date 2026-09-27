import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'
import { requestUpload, confirmUpload, MAX_UPLOAD_BYTES, ImageError } from '../src/assets/image.service.js'

function port(obj: StoredObject | null): AssetStoragePort & { delete: ReturnType<typeof vi.fn> } {
  return {
    createUploadTarget: vi.fn(async (key: string) => ({ uploadUrl: `https://u.test/${key}`, expiresAt: new Date(Date.now() + 60_000) })),
    stat: vi.fn(async () => obj),
    delete: vi.fn(async () => {}),
  } as any
}

let actorId: string
let productId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
  productId = (await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })).id
})
afterAll(() => prisma.$disconnect())

async function pending(byteSize = 5000, contentType = 'image/jpeg') {
  return requestUpload(port(null), { productId, contentType, byteSize }, actorId)
}

describe.each([
  ['upload_too_large', { width: 10, height: 10, byteSize: MAX_UPLOAD_BYTES + 1, contentType: 'image/jpeg' }, MAX_UPLOAD_BYTES + 1],
  ['upload_mismatch', { width: 10, height: 10, byteSize: 9999, contentType: 'image/jpeg' }, 5000],
  ['upload_mismatch', { width: 10, height: 10, byteSize: 5000, contentType: 'image/png' }, 5000],
  ['not_an_image', { width: 0, height: 0, byteSize: 5000, contentType: 'image/jpeg' }, 5000],
] as const)('confirm rejects %s', (code, obj, declared) => {
  it('deletes the object and the row, audits the rejection, and throws', async () => {
    const r = await pending(Math.min(declared, MAX_UPLOAD_BYTES))
    if (declared > MAX_UPLOAD_BYTES) {
      await prisma.image.update({ where: { id: r.imageId }, data: { byteSize: declared } })
    }
    const p = port(obj)
    await expect(confirmUpload(p, r.imageId, actorId)).rejects.toMatchObject({ code })
    expect(p.delete).toHaveBeenCalledWith(r.storageKey)
    expect(await prisma.image.findUnique({ where: { id: r.imageId } })).toBeNull()
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'image.upload.reject' } })
    expect(audit.after).toMatchObject({ code })
  })
})

describe('confirm reject when port.delete throws', () => {
  it('still removes the row and audits the rejection', async () => {
    const r = await pending()
    const p = port({ width: 0, height: 0, byteSize: 5000, contentType: 'image/jpeg' })
    p.delete.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(confirmUpload(p, r.imageId, actorId)).rejects.toMatchObject({ code: 'not_an_image' })
    expect(await prisma.image.findUnique({ where: { id: r.imageId } })).toBeNull()
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'image.upload.reject' } })
    expect(audit.after).toMatchObject({ code: 'not_an_image' })
  })
})

describe('confirm', () => {
  it('is a no-op for an image that is already ready', async () => {
    const r = await pending()
    const ok = port({ width: 800, height: 600, byteSize: 5000, contentType: 'image/jpeg' })
    await confirmUpload(ok, r.imageId, actorId)
    const again = await confirmUpload(ok, r.imageId, actorId)
    expect(again.width).toBe(800)
    expect(await prisma.auditLog.count({ where: { action: 'image.upload.confirm' } })).toBe(1)
  })

  it('refuses SVG at upload-token time', async () => {
    await expect(pending(100, 'image/svg+xml')).rejects.toMatchObject({ code: 'unsupported_content_type' })
    expect(await prisma.image.count()).toBe(0)
  })
})

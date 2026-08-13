import { prisma } from '../prisma.js'
import type { AssetStoragePort } from '../ports/storage/storage.port.js'

export class ImageError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ImageError'
  }
}

export interface ImageDto {
  id: string
  storageKey: string
  alt: string
  position: number
  width: number
  height: number
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** products/{productId}/{imageId}/original.{ext} — the documented key format. */
export function buildStorageKey(productId: string, imageId: string, contentType: string): string {
  const ext = EXT_BY_CONTENT_TYPE[contentType]
  if (!ext) {
    throw new ImageError('unsupported_content_type', `unsupported content type: ${contentType}`)
  }
  return `products/${productId}/${imageId}/original.${ext}`
}

function toDto(row: {
  id: string; storageKey: string; alt: string; position: number; width: number; height: number
}): ImageDto {
  return {
    id: row.id, storageKey: row.storageKey, alt: row.alt,
    position: row.position, width: row.width, height: row.height,
  }
}

export async function requestUpload(
  port: AssetStoragePort,
  input: { productId: string; contentType: string; byteSize: number },
): Promise<{ imageId: string; storageKey: string; uploadUrl: string; expiresAt: Date }> {
  if (!Number.isInteger(input.byteSize) || input.byteSize < 1) {
    throw new ImageError('invalid_byte_size', 'byteSize must be a positive integer')
  }
  if (input.byteSize > MAX_UPLOAD_BYTES) {
    throw new ImageError('file_too_large', `file exceeds ${MAX_UPLOAD_BYTES} bytes`)
  }

  // Validate the content type BEFORE any row is written, so a bad request
  // cannot leave a stray pending row behind.
  const ext = EXT_BY_CONTENT_TYPE[input.contentType]
  if (!ext) {
    throw new ImageError('unsupported_content_type', `unsupported content type: ${input.contentType}`)
  }

  const product = await prisma.product.findUnique({ where: { id: input.productId } })
  if (!product) throw new ImageError('product_not_found', 'product not found')

  const last = await prisma.image.findFirst({
    where: { productId: input.productId },
    orderBy: { position: 'desc' },
  })
  const position = last ? last.position + 1 : 0

  // The key embeds the row id, so the row must exist before the key is known.
  // A placeholder keyed on position would collide after a delete; the id cannot.
  const created = await prisma.image.create({
    data: {
      productId: input.productId,
      storageKey: `pending:${input.productId}:${position}:${Date.now()}`,
      position,
      width: 0,
      height: 0,
      contentType: input.contentType,
      byteSize: input.byteSize,
      status: 'pending',
    },
  })

  const storageKey = buildStorageKey(input.productId, created.id, input.contentType)
  await prisma.image.update({ where: { id: created.id }, data: { storageKey } })

  const target = await port.createUploadTarget(storageKey, input.contentType)
  return {
    imageId: created.id,
    storageKey,
    uploadUrl: target.uploadUrl,
    expiresAt: target.expiresAt,
  }
}

export async function confirmUpload(port: AssetStoragePort, imageId: string): Promise<ImageDto> {
  const row = await prisma.image.findUnique({ where: { id: imageId } })
  if (!row) throw new ImageError('image_not_found', 'image not found')

  // Read the truth from storage. A client-supplied width that disagrees with
  // the real image reintroduces the layout shift width/height exist to prevent.
  const stat = await port.stat(row.storageKey)
  if (!stat) throw new ImageError('object_missing', 'no object was uploaded for this image')

  const updated = await prisma.image.update({
    where: { id: imageId },
    data: {
      width: stat.width,
      height: stat.height,
      byteSize: stat.byteSize,
      status: 'ready',
    },
  })
  return toDto(updated)
}

export async function listReadyImages(productId: string): Promise<ImageDto[]> {
  const rows = await prisma.image.findMany({
    where: { productId, status: 'ready' },
    orderBy: { position: 'asc' },
  })
  return rows.map(toDto)
}

export async function reorderImages(productId: string, orderedIds: string[]): Promise<void> {
  const rows = await prisma.image.findMany({ where: { productId } })
  const known = new Set(rows.map(r => r.id))
  if (orderedIds.length !== rows.length || orderedIds.some(id => !known.has(id))) {
    throw new ImageError('invalid_order', 'ordering must list every image of the product exactly once')
  }
  // One transaction: the position constraint is DEFERRABLE INITIALLY DEFERRED,
  // so intermediate collisions are legal and only the committed state is checked.
  await prisma.$transaction(
    orderedIds.map((id, position) => prisma.image.update({ where: { id }, data: { position } })),
  )
}

export async function deleteImage(port: AssetStoragePort, imageId: string): Promise<void> {
  const row = await prisma.image.findUnique({ where: { id: imageId } })
  if (!row) throw new ImageError('image_not_found', 'image not found')

  const remaining = await prisma.image.findMany({
    where: { productId: row.productId, id: { not: imageId } },
    orderBy: { position: 'asc' },
  })

  await prisma.$transaction([
    prisma.image.delete({ where: { id: imageId } }),
    ...remaining.map((r, position) => prisma.image.update({ where: { id: r.id }, data: { position } })),
  ])

  // Storage last: an orphaned object is recoverable, whereas a row pointing at
  // bytes that no longer exist is a broken product page.
  await port.delete(row.storageKey)
}

export async function sweepPendingImages(port: AssetStoragePort, olderThan: Date): Promise<number> {
  const stale = await prisma.image.findMany({
    where: { status: 'pending', createdAt: { lt: olderThan } },
  })
  for (const row of stale) {
    await prisma.image.delete({ where: { id: row.id } })
    await port.delete(row.storageKey)
  }
  return stale.length
}

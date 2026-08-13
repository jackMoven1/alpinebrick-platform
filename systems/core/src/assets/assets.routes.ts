import { Router, type Response } from 'express'
import type { AssetStoragePort } from '../ports/storage/storage.port.js'
import {
  requestUpload, confirmUpload, reorderImages, deleteImage, ImageError,
} from './image.service.js'
import { prisma } from '../prisma.js'

// Maps a service error code to the HTTP status that describes it.
const STATUS_BY_CODE: Record<string, number> = {
  product_not_found: 404,
  image_not_found: 404,
  object_missing: 409,
  unsupported_content_type: 400,
  file_too_large: 413,
  invalid_byte_size: 400,
  invalid_order: 400,
}

function fail(res: Response, err: unknown) {
  if (err instanceof ImageError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({ code: err.code, message: err.message })
  }
  throw err
}

/**
 * Admin image endpoints.
 *
 * THESE HAVE NO AUTHENTICATION. Neither does the rest of core, so this is not
 * a regression -- but this is the first endpoint that causes arbitrary bytes
 * to be written, so it must not reach a public network before auth exists.
 */
export function createAssetsRouter(port: AssetStoragePort): Router {
  const router = Router()

  router.post('/upload-token', async (req, res) => {
    const { productId, contentType, byteSize } = req.body ?? {}
    if (typeof productId !== 'string' || typeof contentType !== 'string' || typeof byteSize !== 'number') {
      return res.status(400).json({ code: 'invalid_body', message: 'productId, contentType and byteSize are required' })
    }
    try {
      const result = await requestUpload(port, { productId, contentType, byteSize })
      res.status(201).json(result)
    } catch (err) { fail(res, err) }
  })

  router.post('/:id/confirm', async (req, res) => {
    try {
      res.json(await confirmUpload(port, req.params.id))
    } catch (err) { fail(res, err) }
  })

  router.put('/reorder', async (req, res) => {
    const { productId, orderedIds } = req.body ?? {}
    if (typeof productId !== 'string' || !Array.isArray(orderedIds)) {
      return res.status(400).json({ code: 'invalid_body', message: 'productId and orderedIds are required' })
    }
    try {
      await reorderImages(productId, orderedIds)
      res.json({ ok: true })
    } catch (err) { fail(res, err) }
  })

  router.patch('/:id', async (req, res) => {
    const { alt } = req.body ?? {}
    if (typeof alt !== 'string') {
      return res.status(400).json({ code: 'invalid_body', message: 'alt must be a string' })
    }
    const existing = await prisma.image.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ code: 'image_not_found', message: 'image not found' })
    const updated = await prisma.image.update({ where: { id: req.params.id }, data: { alt } })
    res.json({
      id: updated.id, storageKey: updated.storageKey, alt: updated.alt,
      position: updated.position, width: updated.width, height: updated.height,
    })
  })

  router.delete('/:id', async (req, res) => {
    try {
      await deleteImage(port, req.params.id)
      res.status(204).end()
    } catch (err) { fail(res, err) }
  })

  return router
}

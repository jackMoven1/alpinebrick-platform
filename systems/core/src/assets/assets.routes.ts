import { Router, type Response } from 'express'
import type { AssetStoragePort } from '../ports/storage/storage.port.js'
import {
  requestUpload, confirmUpload, reorderImages, deleteImage, updateImageAlt, ImageError,
} from './image.service.js'
import { scrubError } from '../auth/scrub.js'

// Maps a service error code to the HTTP status that describes it.
// lower_snake, deliberately not unified with the catalog router's UPPER_SNAKE.
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
  // Same unhandled-rejection class fixed in admin-catalog.routes.ts's fail():
  // Express 4 does not catch a rejection thrown out of an async handler, so
  // re-throwing an unknown error here left this route hanging instead of
  // responding. Respond instead, and scrub before logging. Kept lower_snake
  // here to match this file's existing convention.
  console.error('[assets] unexpected failure', scrubError(err))
  res.status(500).json({ code: 'internal_error', message: 'internal error' })
}

/**
 * Admin image endpoints.
 *
 * PRECONDITION: this router must be mounted behind `requireAuth`. Every
 * handler below dereferences `req.actor!.id` to attribute its audit row, and
 * that assertion is sound only because `app.ts` mounts `requireAuth` on
 * `/api/v1/admin` ahead of this router -- `req.actor` is never populated on
 * its own. Mount this router bare (as a standalone test app might) and
 * `req.actor` is `undefined`: `req.actor!.id` throws a synchronous
 * `TypeError` before the service (and `recordAudit`) is ever reached, and --
 * because each handler's `catch` calls `fail()`, which responds rather than
 * re-throws -- that surfaces as a quiet 500 instead of a loud crash. A caller
 * wiring this router in standalone (e.g. a test app) must inject `req.actor`
 * itself; see `tests/assets-routes.test.ts`.
 */
export function createAssetsRouter(port: AssetStoragePort): Router {
  const router = Router()

  router.post('/upload-token', async (req, res) => {
    const { productId, contentType, byteSize } = req.body ?? {}
    if (typeof productId !== 'string' || typeof contentType !== 'string' || typeof byteSize !== 'number') {
      return res.status(400).json({ code: 'invalid_body', message: 'productId, contentType and byteSize are required' })
    }
    try {
      const result = await requestUpload(port, { productId, contentType, byteSize }, req.actor!.id)
      res.status(201).json(result)
    } catch (err) { fail(res, err) }
  })

  router.post('/:id/confirm', async (req, res) => {
    try {
      res.json(await confirmUpload(port, req.params.id, req.actor!.id))
    } catch (err) { fail(res, err) }
  })

  router.put('/reorder', async (req, res) => {
    const { productId, orderedIds } = req.body ?? {}
    if (typeof productId !== 'string' || !Array.isArray(orderedIds)) {
      return res.status(400).json({ code: 'invalid_body', message: 'productId and orderedIds are required' })
    }
    try {
      await reorderImages(productId, orderedIds, req.actor!.id)
      res.json({ ok: true })
    } catch (err) { fail(res, err) }
  })

  router.patch('/:id', async (req, res) => {
    const { alt } = req.body ?? {}
    if (typeof alt !== 'string') {
      return res.status(400).json({ code: 'invalid_body', message: 'alt must be a string' })
    }
    try {
      res.json(await updateImageAlt(req.params.id, alt, req.actor!.id))
    } catch (err) { fail(res, err) }
  })

  router.delete('/:id', async (req, res) => {
    try {
      await deleteImage(port, req.params.id, req.actor!.id)
      res.status(204).end()
    } catch (err) { fail(res, err) }
  })

  return router
}

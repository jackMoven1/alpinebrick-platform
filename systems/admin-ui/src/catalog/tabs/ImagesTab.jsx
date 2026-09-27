import { useCallback, useState } from 'react'
import { imageUrlFromKey } from '../../lib/imageUrl.js'
import { errorText } from '../../lib/errorText.js'
import api from '../../data/api.js'
import ProgressBar from '../../ui/ProgressBar.jsx'
import { checkImageFile } from './imageFiles.js'

/**
 * Images arrive from core as immutable storage KEYS, never URLs.
 *
 * Upload runs client checks first (type + 15 MB ceiling — see imageFiles.js,
 * mirroring core's image.service.ts), then per file: request an upload
 * token, PUT straight to storage with progress, then confirm. One file
 * failing shows core's message and a Retry without stopping the others.
 * Task 8 adds the per-photo controls (reorder, alt save, delete) on the
 * read-only grid below.
 */
let nextUploadId = 0

export default function ImagesTab({ product, onUpdated = () => {} }) {
  const images = product.images || []
  const [uploads, setUploads] = useState([])

  const update = useCallback((id, patch) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }, [])

  const runUpload = useCallback(async (u) => {
    update(u.id, { stage: 'uploading', progress: 0, error: null })
    try {
      const t = await api.requestImageUpload(product.id, u.file)
      await api.uploadToStorage(t.uploadUrl, u.file, (p) => update(u.id, { progress: p }))
      update(u.id, { stage: 'confirming' })
      await api.confirmImage(t.imageId)
      update(u.id, { stage: 'done' })
      onUpdated(await api.getProduct(product.id))
    } catch (err) {
      update(u.id, { stage: 'error', error: errorText(err) })
    }
  }, [product.id, onUpdated, update])

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    const entries = files.map((file) => {
      const reason = checkImageFile(file)
      return {
        id: `up-${nextUploadId++}`,
        file,
        precheck: Boolean(reason),
        stage: reason ? 'error' : 'waiting',
        progress: 0,
        error: reason,
      }
    })
    setUploads((prev) => [...prev, ...entries])
    Promise.allSettled(entries.filter((e) => !e.precheck).map(runUpload))
  }, [runUpload])

  const onInputChange = (e) => {
    addFiles(e.target.files)
    e.target.value = ''
  }
  const onDrop = (e) => {
    e.preventDefault()
    addFiles(e.dataTransfer.files)
  }
  const onDragOver = (e) => e.preventDefault()
  const dismiss = (id) => setUploads((prev) => prev.filter((u) => u.id !== id))

  const visibleUploads = uploads.filter((u) => u.stage !== 'done')

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="images-add" className="block text-sm font-medium text-ink">
          Add photos
        </label>
        <div
          onDragOver={onDragOver}
          onDrop={onDrop}
          className="rounded-xl border-2 border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500"
        >
          <p>Drag photos here, or choose files below.</p>
          <input
            id="images-add"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            onChange={onInputChange}
            className="mt-2"
          />
          <p className="mt-1 text-xs text-gray-400">JPEG, PNG or WebP, up to 15 MB each.</p>
        </div>
      </div>

      {visibleUploads.length > 0 && (
        <div className="space-y-2">
          {visibleUploads.map((u) => (
            <div key={u.id} className="rounded-card bg-white p-3 text-sm shadow-card">
              {u.precheck ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-accent">{u.error}</span>
                  <button
                    type="button"
                    onClick={() => dismiss(u.id)}
                    className="rounded-pill bg-gray-200 px-3 py-1 text-xs text-gray-600"
                  >
                    Dismiss
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{u.file.name}</span>
                    <span className="text-xs text-gray-400">{u.stage}</span>
                  </div>
                  {(u.stage === 'uploading' || u.stage === 'confirming') && <ProgressBar value={u.progress} />}
                  {u.stage === 'error' && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-accent">{u.error}</span>
                      <button
                        type="button"
                        aria-label={`Retry ${u.file.name}`}
                        disabled={u.stage === 'uploading' || u.stage === 'confirming'}
                        onClick={() => runUpload(u)}
                        className="rounded-pill bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {images.map((img) => (
          <div key={img.storageKey} className="rounded-card bg-white p-2 shadow-card">
            <img
              src={imageUrlFromKey(img.storageKey, 400)}
              alt={img.alt}
              width={img.width}
              height={img.height}
              className="h-32 w-full rounded-lg object-cover"
            />
            <input value={img.alt} readOnly placeholder="alt text"
              className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600" />
            <div className="mt-2 flex justify-between text-xs text-gray-400">
              <span>position {img.position}</span>
              <button disabled>Delete</button>
            </div>
          </div>
        ))}
        {images.length === 0 && <p className="text-gray-400">No images yet.</p>}
      </div>
    </div>
  )
}

import { useCallback, useRef, useState } from 'react'
import { imageUrlFromKey } from '../../lib/imageUrl.js'
import { errorText } from '../../lib/errorText.js'
import api from '../../data/api.js'
import ProgressBar from '../../ui/ProgressBar.jsx'
import { checkImageFile, ACCEPTED_TYPES } from './imageFiles.js'

/**
 * Images arrive from core as immutable storage KEYS, never URLs.
 *
 * Upload runs client checks first (type + 15 MB ceiling — see imageFiles.js,
 * mirroring core's image.service.ts), then per file: request an upload
 * token, PUT straight to storage with progress, then confirm. One file
 * failing shows core's message and a Retry without stopping the others.
 *
 * The upload (token → PUT → confirm) and the product refresh are separate
 * steps on purpose. Once confirm succeeds the photo is saved server-side —
 * a later refresh failure must never be treated the same as an upload
 * failure, because Retry would re-run requestImageUpload and create a
 * duplicate photo. So a row that finishes confirm goes to 'saved'; refresh
 * is requested once per batch (and once per individual Retry).
 *
 * Refreshes can overlap — a batch refresh, a Retry's refresh and a manual
 * Refresh click can all be in flight together, and their getProduct
 * responses can land in any order. Two guards keep that safe:
 *   - a monotonic request sequence number: a response is only applied
 *     (onUpdated + row changes) if no newer refresh has been issued since
 *     it went out, so an older, slower response can never clobber fresher
 *     data with stale data;
 *   - a per-request snapshot of which row ids were 'saved'/'refresh-error'
 *     at the moment THAT request was issued: on success it clears only
 *     those ids, never rows that reached 'saved' afterward. A row saved
 *     while a refresh is already in flight stays visibly "Saved" until a
 *     refresh issued after it saved actually clears it.
 *
 * Task 8 adds the per-photo controls (reorder, alt save, delete) on the
 * read-only grid below.
 */
let nextUploadId = 0

const STAGE_LABELS = {
  waiting: 'Waiting',
  uploading: 'Uploading…',
  confirming: 'Checking…',
  saved: 'Saved',
  'refresh-error': 'Saved',
  error: 'Failed',
}

export default function ImagesTab({ product, onUpdated = () => {} }) {
  const images = product.images || []
  const [uploads, setUploadsState] = useState([])
  const uploadsRef = useRef([])
  const refreshSeqRef = useRef(0)
  const [refreshInFlight, setRefreshInFlight] = useState(0)

  // uploadsRef is kept in sync synchronously (plain JS, not via React's
  // deferred state updates) so a refresh's id snapshot always reflects the
  // truth at the exact moment it's taken, not a stale render.
  const setUploads = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(uploadsRef.current) : updater
    uploadsRef.current = next
    setUploadsState(next)
  }, [])

  const update = useCallback((id, patch) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }, [setUploads])

  // Re-fetches the product once and applies it. Only the most-recently
  // issued refresh's response is ever applied; an older one that resolves
  // late is dropped entirely (finding 1). On success it clears exactly the
  // rows that were 'saved'/'refresh-error' when THIS refresh was issued —
  // never rows that saved afterward (finding 2).
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    const idsAtIssue = uploadsRef.current
      .filter((u) => u.stage === 'saved' || u.stage === 'refresh-error')
      .map((u) => u.id)
    setRefreshInFlight((n) => n + 1)
    try {
      const fresh = await api.getProduct(product.id)
      if (seq !== refreshSeqRef.current) return // superseded by a newer refresh; stale, ignore
      onUpdated(fresh)
      setUploads((prev) => prev.filter((u) => !idsAtIssue.includes(u.id)))
    } catch (err) {
      if (seq !== refreshSeqRef.current) return // stale, ignore
      const message = errorText(err)
      setUploads((prev) => prev.map((u) => (idsAtIssue.includes(u.id) && u.stage === 'saved' ? { ...u, stage: 'refresh-error', error: message } : u)))
    } finally {
      setRefreshInFlight((n) => n - 1)
    }
  }, [product.id, onUpdated, setUploads])

  const uploadOne = useCallback(async (u) => {
    update(u.id, { stage: 'uploading', progress: 0, error: null })
    try {
      const t = await api.requestImageUpload(product.id, u.file)
      await api.uploadToStorage(t.uploadUrl, u.file, (p) => update(u.id, { progress: Math.round(p * 100) }))
      update(u.id, { stage: 'confirming', progress: 100 })
      await api.confirmImage(t.imageId)
      update(u.id, { stage: 'saved', error: null })
      return { ok: true }
    } catch (err) {
      update(u.id, { stage: 'error', error: errorText(err) })
      return { ok: false }
    }
  }, [product.id, update])

  // A single Retry only re-runs the upload for that row, then refreshes once
  // for it — it never touches rows that are mid-flight elsewhere.
  const retry = useCallback(async (u) => {
    const res = await uploadOne(u)
    if (res.ok) await refresh()
  }, [uploadOne, refresh])

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
    const valid = entries.filter((e) => !e.precheck)
    if (valid.length === 0) return
    Promise.allSettled(valid.map(uploadOne)).then((results) => {
      const anySaved = results.some((r) => r.status === 'fulfilled' && r.value?.ok)
      if (anySaved) return refresh()
    })
  }, [uploadOne, refresh])

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

  const visibleUploads = uploads

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
            accept={ACCEPTED_TYPES.join(',')}
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
                    <span className="text-xs text-gray-400">{STAGE_LABELS[u.stage] ?? u.stage}</span>
                  </div>
                  {(u.stage === 'uploading' || u.stage === 'confirming') && <ProgressBar value={u.progress} />}
                  {u.stage === 'error' && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-accent">{u.error}</span>
                      <button
                        type="button"
                        aria-label={`Retry ${u.file.name}`}
                        onClick={() => retry(u)}
                        className="rounded-pill bg-ink px-3 py-1 text-xs text-white"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {u.stage === 'refresh-error' && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-accent">Photo saved, but the list couldn&rsquo;t refresh ({u.error})</span>
                      <button
                        type="button"
                        disabled={refreshInFlight > 0}
                        onClick={() => refresh()}
                        className="rounded-pill bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
                      >
                        Refresh
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

import { useCallback, useEffect, useRef, useState } from 'react'
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
 * Per-photo controls (Task 8): left/right reorder, an explicitly saved
 * "Description" (alt text, never saved on blur), and Delete behind a
 * confirm. Photos are shown sorted by position and the FIRST shown photo is
 * badged "Main" - positions can have gaps after deletes, so "position 0" is
 * not the test. Only ready photos are shown or sent in a reorder; a pending
 * (unconfirmed) row never appears. Each card has its own busy flag that
 * disables its controls while its request is in flight. Reorder buttons are
 * disabled on every card while any card is busy, and Delete while a reorder
 * is in flight, because an order is computed from the whole list. Every
 * mutation refreshes through refresh(), so card refreshes share the upload
 * path's latest-response guard.
 *
 * The grid is only trusted while it matches core. Moves and deletes are
 * blocked while any refresh is in flight, and after any refresh fails
 * (listStale) until one succeeds: a move computed from a stale order would
 * silently undo an earlier one, and a photo already deleted server-side could
 * be deleted again. A card whose refresh failed offers its own Refresh.
 * Every control is named after its photo (alt, else "photo N") so a screen
 * reader does not hear N identical buttons.
 *
 * The tab is keyed by product id, so switching products unmounts it - but a
 * promise chain it started keeps running. mountedRef stops every async path
 * (upload refresh, reorder, alt, delete) from calling onUpdated or setting
 * state once this instance has unmounted, so a slow response for product A
 * can never overwrite product B.
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

const DELETE_PROMPT = 'Delete this photo? This cannot be undone.'
const SERVER_STATE_ERRORS = new Set(['image_not_found', 'invalid_order'])
// An upload in these stages is (or is about to be) a ready photo on core
// that the grid does not show yet; a reorder would omit it (invalid_order).
const UNSETTLED_UPLOAD_STAGES = new Set(['uploading', 'confirming', 'saved', 'refresh-error'])

// Core's admin DTO already returns only ready photos; this is belt and braces
// so a pending row can never be shown or sent in a reorder.
const visibleImages = (images) => (images || [])
  .filter((img) => img.status === undefined || img.status === 'ready')
  .slice()
  .sort((a, b) => a.position - b.position)

export default function ImagesTab({ product, onUpdated = () => {} }) {
  const images = visibleImages(product.images)
  const [uploads, setUploadsState] = useState([])
  const uploadsRef = useRef([])
  const refreshSeqRef = useRef(0)
  const [refreshInFlight, setRefreshInFlightState] = useState(0)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const setRefreshInFlight = useCallback((u) => {
    if (mountedRef.current) setRefreshInFlightState(u)
  }, [])

  // Per-card state, keyed by image id. busy maps id -> the action in flight
  // ('reorder' | 'alt' | 'delete'); busyRef mirrors it synchronously so a
  // double click can't start a second request before the re-render lands.
  const [busy, setBusyState] = useState({})
  const busyRef = useRef({})
  const [cardErrors, setCardErrors] = useState({})
  const [drafts, setDrafts] = useState({})
  const [listStale, setListStale] = useState(false)
  const setBusy = useCallback((id, kind) => {
    const next = { ...busyRef.current }
    if (kind) next[id] = kind
    else delete next[id]
    busyRef.current = next
    if (mountedRef.current) setBusyState(next)
  }, [])

  // uploadsRef is kept in sync synchronously (plain JS, not via React's
  // deferred state updates) so a refresh's id snapshot always reflects the
  // truth at the exact moment it's taken, not a stale render.
  const setUploads = useCallback((updater) => {
    if (!mountedRef.current) return
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
  // never rows that saved afterward (finding 2). Nothing is applied once the
  // tab has unmounted. Returns what happened, so a card action can report a
  // refresh failure on its own card.
  const refresh = useCallback(async () => {
    if (!mountedRef.current) return { status: 'unmounted' }
    const seq = ++refreshSeqRef.current
    const idsAtIssue = uploadsRef.current
      .filter((u) => u.stage === 'saved' || u.stage === 'refresh-error')
      .map((u) => u.id)
    setRefreshInFlight((n) => n + 1)
    try {
      const fresh = await api.getProduct(product.id)
      if (!mountedRef.current) return { status: 'unmounted' }
      if (seq !== refreshSeqRef.current) return { status: 'stale' } // superseded by a newer refresh; ignore
      onUpdated(fresh)
      setUploads((prev) => prev.filter((u) => !idsAtIssue.includes(u.id)))
      setListStale(false)
      setCardErrors((prev) => {
        const next = {}
        for (const [id, e] of Object.entries(prev)) if (e && !e.refresh) next[id] = e
        return next
      })
      return { status: 'applied' }
    } catch (err) {
      if (!mountedRef.current) return { status: 'unmounted' }
      if (seq !== refreshSeqRef.current) return { status: 'stale' } // stale, ignore
      const message = errorText(err)
      setListStale(true)
      setUploads((prev) => prev.map((u) => (idsAtIssue.includes(u.id) && u.stage === 'saved' ? { ...u, stage: 'refresh-error', error: message } : u)))
      return { status: 'error', error: message }
    } finally {
      setRefreshInFlight((n) => n - 1)
    }
  }, [product.id, onUpdated, setUploads, setRefreshInFlight])

  // One card action: refuse a second request while one is in flight, run the
  // mutation, then refresh the product. Errors land on that card only.
  const runCardAction = useCallback(async (id, kind, mutate) => {
    if (busyRef.current[id]) return { ok: false }
    setBusy(id, kind)
    if (mountedRef.current) setCardErrors((prev) => ({ ...prev, [id]: null }))
    try {
      try {
        await mutate()
      } catch (err) {
        if (mountedRef.current) setCardErrors((prev) => ({ ...prev, [id]: { message: errorText(err), refresh: false } }))
        // Core says the grid no longer matches it (photo gone, or the order
        // omits/adds a photo): refetch so the grid heals instead of repeating
        // the same failing request.
        if (SERVER_STATE_ERRORS.has(err?.code) && mountedRef.current) await refresh()
        return { ok: false }
      }
      if (!mountedRef.current) return { ok: true, refreshed: 'unmounted' }
      const r = await refresh()
      if (r.status === 'error' && mountedRef.current) {
        setCardErrors((prev) => ({ ...prev, [id]: { message: `Done, but the list couldn’t refresh (${r.error})`, refresh: true } }))
      }
      return { ok: true, refreshed: r.status }
    } finally {
      setBusy(id, null)
    }
  }, [refresh, setBusy])

  // Moves and deletes act on the order/set shown; only trust it while it
  // matches core: no refresh in flight, none failed since the last success,
  // and no upload that is on (or about to be on) core but not in the grid.
  const uploadUnsettled = uploads.some((u) => UNSETTLED_UPLOAD_STAGES.has(u.stage))
  const gridLocked = refreshInFlight > 0 || listStale || uploadUnsettled

  const move = (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= images.length) return
    if (Object.keys(busyRef.current).length > 0 || gridLocked) return
    const ids = images.map((img) => img.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    runCardAction(images[index].id, 'reorder', () => api.reorderImages(product.id, ids))
  }

  const saveAlt = async (img) => {
    const alt = drafts[img.id]
    if (alt === undefined || alt === (img.alt ?? '')) return
    const res = await runCardAction(img.id, 'alt', () => api.updateImageAlt(img.id, alt))
    // Drop the draft only once the refreshed product (which carries it) is applied.
    if (res.ok && res.refreshed === 'applied' && mountedRef.current) {
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[img.id]
        return next
      })
    }
  }

  const remove = (img) => {
    if (busyRef.current[img.id]) return
    if (Object.values(busyRef.current).includes('reorder') || gridLocked) return
    if (!window.confirm(DELETE_PROMPT)) return
    runCardAction(img.id, 'delete', () => api.deleteImage(img.id))
  }

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

      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((u) => (
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
                  {(u.stage === 'uploading' || u.stage === 'confirming') && <ProgressBar value={u.progress} label={`Uploading ${u.file.name}`} />}
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
                        aria-label={`Refresh: ${u.file.name}`}
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
        {images.map((img, index) => {
          const cardBusy = Boolean(busy[img.id])
          const anyBusy = Object.keys(busy).length > 0
          const reorderBusy = Object.values(busy).includes('reorder')
          const savedAlt = img.alt ?? ''
          const draft = drafts[img.id]
          const altChanged = draft !== undefined && draft !== savedAlt
          const inputId = `image-alt-${img.id}`
          const hintId = `image-alt-hint-${img.id}`
          const name = img.alt || `photo ${index + 1}`
          const cardError = cardErrors[img.id]
          return (
            <div key={img.id} data-testid={`image-${img.id}`} className="rounded-card bg-white p-2 shadow-card">
              <div className="relative">
                <img
                  src={imageUrlFromKey(img.storageKey, 400)}
                  alt={img.alt}
                  width={img.width}
                  height={img.height}
                  className="h-32 w-full rounded-lg object-cover"
                />
                {index === 0 && (
                  <span className="absolute left-2 top-2 rounded-pill bg-ink px-2 py-0.5 text-xs text-white">Main</span>
                )}
              </div>
              <label htmlFor={inputId} className="mt-2 block text-xs font-medium text-ink">Description</label>
              <div className="mt-1 flex gap-2">
                <input
                  id={inputId}
                  aria-describedby={savedAlt ? undefined : hintId}
                  value={draft ?? savedAlt}
                  disabled={cardBusy}
                  onChange={(e) => {
                    const value = e.target.value
                    setDrafts((prev) => ({ ...prev, [img.id]: value }))
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
                />
                <button
                  type="button"
                  aria-label={`Save: ${name}`}
                  disabled={cardBusy || !altChanged}
                  onClick={() => saveAlt(img)}
                  className="rounded-pill bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
                >
                  Save
                </button>
              </div>
              {!savedAlt && (
                <p id={hintId} className="mt-1 text-xs text-gray-400">Add a description — used by screen readers and search engines.</p>
              )}
              {cardError && (
                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="text-accent">{cardError.message}</span>
                  {cardError.refresh && (
                    <button
                      type="button"
                      aria-label={`Refresh: ${name}`}
                      disabled={refreshInFlight > 0}
                      onClick={() => refresh()}
                      className="rounded-pill bg-ink px-3 py-1 text-white disabled:opacity-50"
                    >
                      Refresh
                    </button>
                  )}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Move left: ${name}`}
                    disabled={anyBusy || gridLocked || index === 0}
                    onClick={() => move(index, -1)}
                    className="rounded-pill bg-gray-200 px-2 py-1 text-gray-700 disabled:opacity-50"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    aria-label={`Move right: ${name}`}
                    disabled={anyBusy || gridLocked || index === images.length - 1}
                    onClick={() => move(index, 1)}
                    className="rounded-pill bg-gray-200 px-2 py-1 text-gray-700 disabled:opacity-50"
                  >
                    →
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={`Delete: ${name}`}
                  disabled={cardBusy || reorderBusy || gridLocked}
                  onClick={() => remove(img)}
                  className="rounded-pill bg-gray-200 px-3 py-1 text-accent disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })}
        {images.length === 0 && <p className="text-gray-400">No images yet.</p>}
      </div>
    </div>
  )
}

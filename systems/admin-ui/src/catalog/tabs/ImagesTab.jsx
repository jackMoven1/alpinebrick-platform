import { imageUrlFromKey } from '../../lib/imageUrl.js'

/**
 * Read-only in the Phase B slice.
 *
 * Three of this tab's four operations — reorder, alt text, delete — already
 * have working endpoints in core. Its entry point does not: addImage needs the
 * two-phase upload-token/confirm rework. An Images tab where you can reorder
 * and delete but never add is a worse experience than one honestly switched
 * off, so the whole tab waits for upload.
 *
 * Images arrive from core as immutable storage KEYS, never URLs.
 */
export default function ImagesTab({ product }) {
  const images = product.images || []

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600">
        Managing images is not in this phase — this view is read-only.
      </div>

      <button disabled className="rounded-pill bg-gray-200 px-4 py-2 text-sm text-gray-500">
        Upload image
      </button>

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

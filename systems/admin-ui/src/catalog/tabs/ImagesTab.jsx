import mockApi from '../../data/mockApi.js'
import Button from '../../ui/Button.jsx'

export default function ImagesTab({ product, onUpdated }) {
  const refresh = async () => onUpdated(await mockApi.getProduct(product.id))

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file) // Phase A mock upload
    await mockApi.addImage(product.id, { url, alt_text: file.name })
    refresh()
  }
  const move = async (idx, dir) => {
    const ids = product.images.map((i) => i.id)
    const j = idx + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    await mockApi.reorderImages(product.id, ids)
    refresh()
  }
  const setAlt = async (id, alt) => { await mockApi.updateImageAlt(product.id, id, alt); refresh() }
  const del = async (id) => { await mockApi.deleteImage(product.id, id); refresh() }

  return (
    <div className="space-y-4">
      <label className="inline-block cursor-pointer rounded-pill bg-ink px-4 py-2 text-sm font-semibold text-white">
        Upload image
        <input type="file" accept="image/*" className="hidden" onChange={onFile} />
      </label>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {product.images.map((img, idx) => (
          <div key={img.id} className="rounded-card bg-white p-2 shadow-card">
            <img src={img.url} alt={img.alt_text} className="h-32 w-full rounded-lg object-cover" />
            <input value={img.alt_text} onChange={(e) => setAlt(img.id, e.target.value)}
              placeholder="alt text" className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1 text-xs" />
            <div className="mt-2 flex justify-between text-xs">
              <span>
                <button onClick={() => move(idx, -1)} className="px-1">↑</button>
                <button onClick={() => move(idx, 1)} className="px-1">↓</button>
              </span>
              <button onClick={() => del(img.id)} className="text-accent">Delete</button>
            </div>
          </div>
        ))}
        {product.images.length === 0 && <p className="text-gray-400">No images yet.</p>}
      </div>
    </div>
  )
}

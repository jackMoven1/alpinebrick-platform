import { useState } from 'react'
import mockApi from '../../data/mockApi.js'
import { useAutoSave } from '../useAutoSave.js'

export default function InfoTab({ product, onUpdated }) {
  const [form, setForm] = useState({
    name: product.name, description: product.description,
    categories: (product.categories || []).join(', '),
  })
  const [status, trigger] = useAutoSave()

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    trigger(async () => {
      const patch = k === 'categories'
        ? { categories: v.split(',').map((c) => c.trim()).filter(Boolean) }
        : { [k]: v }
      const updated = await mockApi.updateProduct(product.id, patch)
      onUpdated(updated)
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400 h-4">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : ''}</p>
      <label className="block">
        <span className="text-sm font-semibold">Name</span>
        <input value={form.name} onChange={(e) => set('name', e.target.value)}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Description</span>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={4}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Categories</span>
        <input value={form.categories} onChange={(e) => set('categories', e.target.value)}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import { slugify } from '../lib/slug.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

export default function ProductForm() {
  const nav = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', description: '', categories: '', slug: '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const previewSlug = form.slug || slugify(form.name)
  const valid = form.name.trim().length > 0

  const submit = async (e) => {
    e.preventDefault()
    if (!valid) { setErrors({ name: 'Name is required' }); return }
    setSaving(true)
    try {
      const p = await mockApi.createProduct({
        name: form.name.trim(),
        description: form.description,
        slug: form.slug || undefined,
        categories: form.categories.split(',').map((c) => c.trim()).filter(Boolean),
        metadata: {},
      })
      toast.push('Product created')
      nav(`/products/${p.id}`)
    } catch (err) {
      setErrors(err.fields || { name: err.message })
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold">New product</h1>
      <Card className="mt-4">
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-semibold">Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
            {errors.name && <span className="text-xs text-accent">{errors.name}</span>}
            {previewSlug && <span className="mt-1 block text-xs text-gray-400">slug: {previewSlug}</span>}
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Description</span>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={4} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Categories <span className="text-gray-400">(comma-separated)</span></span>
            <input value={form.categories} onChange={(e) => set('categories', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || saving}>{saving ? 'Creating…' : 'Create product'}</Button>
            <Button type="button" variant="ghost" onClick={() => nav('/products')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

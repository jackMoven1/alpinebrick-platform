import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../data/api.js'
import { slugify } from '../lib/slug.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

const TYPES = [
  { value: 'resale', label: 'Resale / collectible', hint: 'A set we bought to sell on' },
  { value: 'own_designed', label: 'Own design', hint: 'Designed for Alpine Brick' },
]

export default function ProductForm() {
  const nav = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', productType: '', description: '', slug: '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const previewSlug = form.slug || slugify(form.name)
  const valid = form.name.trim().length > 0 && form.productType !== ''

  const submit = async (e) => {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    try {
      const p = await api.createProduct({
        name: form.name.trim(),
        productType: form.productType,
        description: form.description,
        ...(form.slug ? { slug: form.slug } : {}),
      })
      toast.push('Draft created')
      nav(`/products/${p.id}`)
    } catch (err) {
      setErrors(err.fields || { name: err.message })
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold">New product</h1>
      <p className="text-gray-500">Starts as a draft. Nothing reaches the storefront until you publish.</p>
      <Card className="mt-4">
        <form onSubmit={submit} className="space-y-4">
          <div className="block">
            <label className="text-sm font-semibold" htmlFor="pf-name">Name</label>
            <input id="pf-name" value={form.name} onChange={(e) => set('name', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
            {errors.name && <span className="text-xs text-accent">{errors.name}</span>}
          </div>
          <div className="block">
            <label className="text-sm font-semibold" htmlFor="pf-slug">URL slug</label>
            <span className="text-gray-400"> (optional)</span>
            <input id="pf-slug" value={form.slug} placeholder={previewSlug} onChange={(e) => set('slug', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 font-mono text-sm" />
            <span className="mt-1 block text-xs text-gray-400">/products/{previewSlug || '…'} — locks once published</span>
            {errors.slug && <span className="text-xs text-accent">{errors.slug}</span>}
          </div>
          <fieldset>
            <legend className="text-sm font-semibold">Type</legend>
            <div className="mt-1 flex gap-4">
              {TYPES.map((t) => (
                <label key={t.value} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="productType" value={t.value} checked={form.productType === t.value}
                    onChange={() => set('productType', t.value)} aria-label={t.label} />
                  <span>{t.label}<span className="block text-xs text-gray-400">{t.hint}</span></span>
                </label>
              ))}
            </div>
            {errors.productType && <span className="text-xs text-accent">{errors.productType}</span>}
          </fieldset>
          <label className="block" htmlFor="pf-desc">
            <span className="text-sm font-semibold">Short description</span>
            <textarea id="pf-desc" value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={3} maxLength={500} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
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

import { useEffect, useMemo, useState } from 'react'
import api from '../../data/api.js'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'
import { errorText } from '../../lib/errorText.js'

/**
 * Explicit Save, never auto-save: on a published product every keystroke
 * would otherwise go straight to the live storefront (spec §6).
 */
const lines = (arr) => (arr || []).join('\n')
const csv = (arr) => (arr || []).join(', ')

export function toForm(p) {
  return {
    name: p.name, slug: p.slug, productType: p.productType, releaseType: p.releaseType,
    categories: csv(p.categories), description: p.description ?? '', longDescription: p.longDescription ?? '',
    pieces: p.pieces ?? '', difficulty: p.difficulty ?? '', ageRecommendation: p.ageRecommendation ?? '',
    dimensions: p.dimensions ?? '', features: lines(p.features), includes: lines(p.includes),
    builderNotes: p.builderNotes ?? '', homePosition: p.homePosition ?? '', collectionPosition: p.collectionPosition ?? '',
  }
}

// Blank -> null. A string of digits only -> a Number. Anything else (e.g.
// "1oo") -> the trimmed raw string, so the edit is detected as dirty and
// sent to core, which rejects it with its own field error — rather than
// silently coercing to NaN, whose JSON.stringify is "null" and would either
// clear a populated field or hide the edit entirely on an empty one.
const intOrNull = (v) => {
  const s = String(v).trim()
  if (s === '') return null
  return /^\d+$/.test(s) ? Number(s) : s
}
const textOrNull = (v) => (String(v).trim() === '' ? null : String(v).trim())
const splitLines = (v) => String(v).split('\n').map((s) => s.trim()).filter(Boolean)
const splitCsv = (v) => [...new Set(String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]

const CONVERT = {
  pieces: intOrNull, homePosition: intOrNull, collectionPosition: intOrNull,
  difficulty: textOrNull, ageRecommendation: textOrNull, dimensions: textOrNull,
  features: splitLines, includes: splitLines, categories: splitCsv,
  name: (v) => String(v).trim(),
}

export function diffPatch(product, form) {
  const base = toForm(product)
  const patch = {}
  for (const k of Object.keys(form)) {
    const conv = CONVERT[k] ?? ((v) => v)
    const next = conv(form[k])
    const prev = conv(base[k])
    if (JSON.stringify(next) !== JSON.stringify(prev)) patch[k] = next
  }
  return patch
}

// R1: hint/error must NOT live inside the <label> — getByLabelText computes
// the accessible name from everything inside the label, so a hint or error
// string would get appended to the name and break `getByLabelText('URL slug')` /
// `getByLabelText('Pieces')` the moment either renders. The label wraps only
// the field name text; hint/error render as siblings after it.
function Field({ id, label, error, hint, children }) {
  return (
    <div className="block">
      <label className="text-sm font-semibold" htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
      {error && <span className="block text-xs text-accent">{error}</span>}
    </div>
  )
}

const input = 'mt-1 w-full rounded-xl border border-gray-200 px-3 py-2'

export default function InfoTab({ product, onUpdated, onDirtyChange }) {
  const toast = useToast()
  const [form, setForm] = useState(() => toForm(product))
  const [errors, setErrors] = useState({})
  // A failure that belongs to no field shown here (e.g. NOT_FOUND, a 500):
  // rendered beside Save, never under Name.
  const [formError, setFormError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setForm(toForm(product)); setErrors({}); setFormError(null) }, [product])
  const patch = useMemo(() => diffPatch(product, form), [product, form])
  const dirty = Object.keys(patch).length > 0

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Tells the parent whenever dirtiness changes, and clears it on unmount —
  // ProductDetail uses this to ask before switching away from an unsaved
  // Info edit (spec §6), the same rule the beforeunload guard enforces for
  // a browser tab close.
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const f = (id, label, extra = {}) => ({ id: `info-${id}`, label, error: errors[id], ...extra })

  const save = async () => {
    if (saving) return
    setSaving(true); setErrors({}); setFormError(null)
    try {
      onUpdated(await api.updateProduct(product.id, patch))
      toast.push(product.status === 'published' ? 'Saved — live on the storefront now' : 'Saved')
    } catch (err) {
      const fields = err.fields ?? {}
      setErrors(fields)
      const shown = Object.keys(toForm(product))
      if (Object.keys(fields).length === 0 || Object.keys(fields).some((k) => !shown.includes(k))) setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-bold">Basics</h3>
        <Field {...f('name', 'Name')}><input id="info-name" value={form.name} onChange={set('name')} className={input} /></Field>
        <Field {...f('slug', 'URL slug', { hint: product.locked?.slug ? 'Locked because this product has been published — its URL may already be linked.' : `/products/${form.slug}` })}>
          <input id="info-slug" value={form.slug} onChange={set('slug')} readOnly={product.locked?.slug}
            className={`${input} font-mono text-sm read-only:bg-gray-50 read-only:text-gray-500`} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field {...f('productType', 'Type')}>
            <select id="info-productType" value={form.productType} onChange={set('productType')} className={input}>
              <option value="resale">Resale / collectible</option><option value="own_designed">Own design</option>
            </select>
          </Field>
          <Field {...f('releaseType', 'Release type')}>
            <select id="info-releaseType" value={form.releaseType} onChange={set('releaseType')} className={input}>
              <option value="standard">Standard</option><option value="limited_run">Limited run</option><option value="specialty">Specialty</option>
            </select>
          </Field>
        </div>
        <Field {...f('categories', 'Categories', { hint: 'Comma-separated tags, e.g. castle, star-wars' })}>
          <input id="info-categories" value={form.categories} onChange={set('categories')} className={input} />
        </Field>
      </section>

      <section className="space-y-3">
        <h3 className="font-bold">Description</h3>
        <Field {...f('description', 'Short description')}><textarea id="info-description" rows={3} maxLength={500} value={form.description} onChange={set('description')} className={input} /></Field>
        <Field {...f('longDescription', 'Long description')}><textarea id="info-longDescription" rows={6} value={form.longDescription} onChange={set('longDescription')} className={input} /></Field>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <h3 className="col-span-2 font-bold">Build details</h3>
        <Field {...f('pieces', 'Pieces')}><input id="info-pieces" inputMode="numeric" value={form.pieces} onChange={set('pieces')} className={input} /></Field>
        <Field {...f('difficulty', 'Difficulty')}>
          <select id="info-difficulty" value={form.difficulty} onChange={set('difficulty')} className={input}>
            <option value="">—</option><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option><option value="expert">Expert</option>
          </select>
        </Field>
        <Field {...f('ageRecommendation', 'Age')}><input id="info-ageRecommendation" value={form.ageRecommendation} onChange={set('ageRecommendation')} className={input} /></Field>
        <Field {...f('dimensions', 'Dimensions')}><input id="info-dimensions" value={form.dimensions} onChange={set('dimensions')} className={input} /></Field>
      </section>

      <section className="space-y-3">
        <h3 className="font-bold">Contents</h3>
        <Field {...f('features', 'Features', { hint: 'One per line' })}><textarea id="info-features" rows={4} value={form.features} onChange={set('features')} className={input} /></Field>
        <Field {...f('includes', "What's included", { hint: 'One per line' })}><textarea id="info-includes" rows={3} value={form.includes} onChange={set('includes')} className={input} /></Field>
        <Field {...f('builderNotes', 'Builder notes')}><textarea id="info-builderNotes" rows={3} value={form.builderNotes} onChange={set('builderNotes')} className={input} /></Field>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <h3 className="col-span-2 font-bold">Merchandising</h3>
        <Field {...f('homePosition', 'Home page position', { hint: 'Blank sorts last' })}><input id="info-homePosition" inputMode="numeric" value={form.homePosition} onChange={set('homePosition')} className={input} /></Field>
        <Field {...f('collectionPosition', 'Collection position', { hint: 'Blank sorts last' })}><input id="info-collectionPosition" inputMode="numeric" value={form.collectionPosition} onChange={set('collectionPosition')} className={input} /></Field>
      </section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-gray-100 bg-white py-3">
        <Button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        {dirty && <span className="text-sm text-gray-500">Unsaved changes{product.status === 'published' ? ' — saving updates the live storefront' : ''}</span>}
        {dirty && <Button variant="ghost" onClick={() => { setForm(toForm(product)); setErrors({}); setFormError(null) }}>Discard</Button>}
        {formError && <span role="alert" className="text-sm text-accent">{formError}</span>}
      </div>
    </div>
  )
}

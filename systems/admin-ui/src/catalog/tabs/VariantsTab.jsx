import { useState } from 'react'
import mockApi from '../../data/mockApi.js'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'
import BulkVariantForm from './BulkVariantForm.jsx'

export default function VariantsTab({ product, onUpdated }) {
  const toast = useToast()
  const [draft, setDraft] = useState({ sku: '', price: '' })
  const [error, setError] = useState(null)

  const refresh = async () => onUpdated(await mockApi.getProduct(product.id))

  const add = async () => {
    setError(null)
    try {
      await mockApi.createVariant(product.id, { sku: draft.sku.trim(), price: Number(draft.price) || 0, attributes: {} })
      setDraft({ sku: '', price: '' })
      toast.push('Variant added')
      refresh()
    } catch (e) { setError(e.message) }
  }
  const remove = async (vid) => { await mockApi.deleteVariant(product.id, vid); toast.push('Variant removed'); refresh() }
  const bulk = async (tpl) => { await mockApi.bulkCreateVariants(product.id, tpl); toast.push('Variants created'); refresh() }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500"><tr><th className="py-2">SKU</th><th>Price</th><th>Attributes</th><th></th></tr></thead>
        <tbody>
          {product.variants.map((v) => (
            <tr key={v.id} className="border-t border-gray-100">
              <td className="py-2 font-mono">{v.sku}</td>
              <td>${v.price.toFixed(2)}</td>
              <td className="text-gray-500">{Object.entries(v.attributes || {}).map(([k, val]) => `${k}:${val}`).join(', ') || '—'}</td>
              <td className="text-right"><button onClick={() => remove(v.id)} className="text-accent text-xs">Delete</button></td>
            </tr>
          ))}
          {product.variants.length === 0 && <tr><td colSpan={4} className="py-4 text-gray-400">No variants yet.</td></tr>}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price" type="number" value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <Button onClick={add} disabled={!draft.sku.trim()}>Add variant</Button>
        {error && <span className="text-xs text-accent">{error}</span>}
      </div>

      <BulkVariantForm onCreate={bulk} />
    </div>
  )
}

import { useState } from 'react'
import { generateVariants } from '../../lib/variants.js'
import Button from '../../ui/Button.jsx'

export default function BulkVariantForm({ onCreate }) {
  const [tpl, setTpl] = useState({ sku_prefix: '', price: '', attribute_key: 'size', values: '' })
  const set = (k, v) => setTpl((t) => ({ ...t, [k]: v }))
  const preview = generateVariants({ ...tpl, price: Number(tpl.price) || 0, values: tpl.values.split(',') })

  return (
    <div className="rounded-xl border border-dashed border-gray-300 p-4">
      <h4 className="font-semibold">Bulk create variants</h4>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input placeholder="SKU prefix" value={tpl.sku_prefix} onChange={(e) => set('sku_prefix', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price" type="number" value={tpl.price} onChange={(e) => set('price', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Attribute (e.g. size)" value={tpl.attribute_key} onChange={(e) => set('attribute_key', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Values: S,M,L" value={tpl.values} onChange={(e) => set('values', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
      </div>
      {preview.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">Will create: {preview.map((v) => v.sku).join(', ')}</p>
      )}
      <Button variant="brand" className="mt-3" disabled={preview.length === 0}
        onClick={() => onCreate({ ...tpl, price: Number(tpl.price) || 0, values: tpl.values.split(',') })}>
        Create {preview.length} variant(s)
      </Button>
    </div>
  )
}

import BulkVariantForm from './BulkVariantForm.jsx'

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})

/**
 * Read-only in the Phase B slice.
 *
 * Variant CRUD has no endpoints in core yet, so every control is disabled
 * rather than left to throw after a form is filled in.
 *
 * Note the money handling: core returns `priceCents` as an integer. The old
 * mock returned a float `price`, and calling .toFixed on it here would throw
 * against real data. Cents become dollars exactly once, at render.
 */
export default function VariantsTab({ product }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600">
        Editing variants is not in this phase — this view is read-only.
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr><th className="py-2">SKU</th><th>Price</th><th>Currency</th><th></th></tr>
        </thead>
        <tbody>
          {product.variants.map((v) => (
            <tr key={v.id} className="border-t border-gray-100">
              <td className="py-2 font-mono">{v.sku}</td>
              <td>{MONEY.format((v.priceCents ?? 0) / 100)}</td>
              <td className="text-gray-500">{v.currency || '—'}</td>
              <td className="text-right">
                <button disabled className="text-xs text-gray-400">Delete</button>
              </td>
            </tr>
          ))}
          {product.variants.length === 0 && (
            <tr><td colSpan={4} className="py-4 text-gray-400">No variants yet.</td></tr>
          )}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <input placeholder="SKU" disabled className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-sm" />
        <input placeholder="Price" type="number" disabled className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-sm" />
        <button disabled className="rounded-pill bg-gray-200 px-4 py-2 text-sm text-gray-500">Add variant</button>
      </div>

      <BulkVariantForm onCreate={() => {}} disabled />
    </div>
  )
}

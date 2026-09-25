import { useState } from 'react'
import api from '../../data/api.js'
import { dollarsToCents } from '../../lib/money.js'
import { useToast } from '../../ui/toast.jsx'
import BulkVariantForm from './BulkVariantForm.jsx'
import StockDialog from './StockDialog.jsx'
import { errorText } from '../../lib/errorText.js'

const LOCK_REASON = 'Locked: this variant has been sold or listed on Walmart'

/** Read-only: attributes are set at creation (spec §6). */
const formatAttributes = (attrs) => {
  const pairs = Object.entries(attrs ?? {})
  return pairs.length ? pairs.map(([k, val]) => `${k}: ${val}`).join(', ') : '—'
}

/**
 * Money: core speaks integer cents. Dollars text becomes cents exactly once,
 * through dollarsToCents, and cents become dollars text only for display.
 */
function VariantRow({ v, onUpdated, onSetStock }) {
  const toast = useToast()
  const [sku, setSku] = useState(v.sku)
  const [price, setPrice] = useState((v.priceCents / 100).toFixed(2))
  const [error, setError] = useState(null)
  // One request at a time per row: a double-click must not send it twice.
  const [busy, setBusy] = useState(false)
  const cents = dollarsToCents(price)
  const dirty = sku !== v.sku || cents !== v.priceCents

  const run = async (request, done) => {
    if (busy) return
    setError(null); setBusy(true)
    try { onUpdated(await request()); toast.push(done) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const save = () => {
    const patch = {}
    if (sku !== v.sku) patch.sku = sku
    if (cents !== v.priceCents) patch.priceCents = cents
    return run(() => api.updateVariant(v.id, patch), 'Variant saved')
  }
  const remove = () => {
    if (busy || !window.confirm(`Delete ${v.sku}? This cannot be undone.`)) return undefined
    return run(() => api.deleteVariant(v.id), 'Variant deleted')
  }
  const inv = v.inventory
  const walmart = inv.walmartAllocation === null ? 'Shared' : `Walmart ${inv.walmartAllocation}`

  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="py-2">
        <input aria-label={`SKU ${v.sku}`} value={sku} onChange={(e) => setSku(e.target.value)} readOnly={v.locked.sku}
          title={v.locked.sku ? LOCK_REASON : undefined}
          className="w-32 rounded-lg border border-gray-200 px-2 py-1 font-mono read-only:bg-gray-50" />
        {error && <span className="block text-xs text-accent">{error}</span>}
      </td>
      <td>
        <input aria-label={`Price ${v.sku}`} value={price} onChange={(e) => setPrice(e.target.value)}
          className="w-24 rounded-lg border border-gray-200 px-2 py-1" />
      </td>
      <td className="text-gray-500">{formatAttributes(v.attributes)}</td>
      <td>{inv.onHand}</td>
      <td className="text-gray-500">{inv.reserved}</td>
      <td className="text-gray-500">{walmart}</td>
      <td>{inv.storefrontAvailable}</td>
      <td>{inv.walmartAvailable}</td>
      <td className="space-x-2 whitespace-nowrap text-right">
        {dirty && <button onClick={save} disabled={busy || cents === null || !sku.trim()} className="text-xs font-semibold text-brand-dark disabled:text-gray-300">Save</button>}
        <button onClick={() => onSetStock(v)} className="text-xs font-semibold">Set stock</button>
        <button onClick={remove} disabled={busy || v.locked.delete} title={v.locked.delete ? LOCK_REASON : undefined}
          className="text-xs text-accent disabled:text-gray-300">Delete</button>
      </td>
    </tr>
  )
}

export default function VariantsTab({ product, onUpdated }) {
  const [draft, setDraft] = useState({ sku: '', price: '', qty: '' })
  const [error, setError] = useState(null)
  // Held here, not in the row, so the dialog never renders inside a <tr>.
  const [stockFor, setStockFor] = useState(null)
  const [adding, setAdding] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const cents = dollarsToCents(draft.price)
  const qtyOk = draft.qty.trim() === '' || /^\d+$/.test(draft.qty.trim())

  const add = async () => {
    if (adding) return
    setError(null); setAdding(true)
    try {
      onUpdated(await api.createVariant(product.id, {
        sku: draft.sku.trim(), priceCents: cents, ...(draft.qty.trim() !== '' ? { onHand: Number(draft.qty.trim()) } : {}),
      }))
      setDraft({ sku: '', price: '', qty: '' })
    } catch (e) { setError(errorText(e)) } finally { setAdding(false) }
  }
  const bulk = async (rows) => {
    if (bulkBusy) return
    setError(null); setBulkBusy(true)
    try { onUpdated(await api.bulkCreateVariants(product.id, rows)) } catch (e) { setError(errorText(e)) } finally { setBulkBusy(false) }
  }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr><th className="py-2">SKU</th><th>Price</th><th>Attributes</th><th>On hand</th><th>Reserved</th><th>Walmart</th><th>Store can sell</th><th>Walmart can sell</th><th></th></tr>
        </thead>
        <tbody>
          {product.variants.map((v) => (
            // Keyed on the saved values so a server update resets the row's edit state.
            <VariantRow key={`${v.id}:${v.sku}:${v.priceCents}`} v={v} onUpdated={onUpdated} onSetStock={setStockFor} />
          ))}
          {product.variants.length === 0 && <tr><td colSpan={9} className="py-4 text-gray-400">No variants yet.</td></tr>}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <input placeholder="SKU" value={draft.sku} onChange={set('sku')} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price $" value={draft.price} onChange={set('price')} className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Qty" inputMode="numeric" value={draft.qty} onChange={set('qty')} className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <button onClick={add} disabled={adding || !draft.sku.trim() || cents === null || !qtyOk}
          className="rounded-pill bg-ink px-4 py-2 text-sm text-white disabled:bg-gray-200 disabled:text-gray-500">Add variant</button>
      </div>
      {error && <p className="text-sm text-accent">{error}</p>}

      <BulkVariantForm onCreate={bulk} disabled={bulkBusy} />
      <p className="text-xs text-gray-400">Prices are in US dollars.</p>

      {stockFor && (
        <StockDialog
          variant={product.variants.find((x) => x.id === stockFor.id) ?? stockFor}
          onClose={() => setStockFor(null)}
          onSaved={onUpdated}
        />
      )}
    </div>
  )
}

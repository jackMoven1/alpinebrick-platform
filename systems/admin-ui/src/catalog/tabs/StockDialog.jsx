import { useEffect, useState } from 'react'
import api from '../../data/api.js'
import Modal from '../../ui/Modal.jsx'
import Button from '../../ui/Button.jsx'
import { errorText } from '../../lib/errorText.js'

/**
 * Mirrors core's src/inventory/allocation.ts (storefrontSellable /
 * walmartSellable) — keep the two in step.
 */
export function previewSplit(onHand, reserved, allocation) {
  const free = Math.max(0, onHand - reserved)
  return {
    storefront: Math.max(0, onHand - reserved - (allocation ?? 0)),
    walmart: allocation === null ? free : Math.min(allocation, free),
    shared: allocation === null,
  }
}

const WHOLE = /^\d+$/

export default function StockDialog({ variant, onClose, onSaved }) {
  const inv = variant.inventory
  const [onHand, setOnHand] = useState(String(inv.onHand))
  const [mode, setMode] = useState(inv.walmartAllocation === null ? 'shared' : 'split')
  const [allocation, setAllocation] = useState(String(inv.walmartAllocation ?? 0))
  const [note, setNote] = useState('')
  const [expected, setExpected] = useState(inv.onHand)
  const [conflict, setConflict] = useState(null)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api.getStockHistory(variant.id)
      .then((h) => { if (live) setHistory(Array.isArray(h) ? h : []) })
      .catch(() => { if (live) setHistory([]) })
    return () => { live = false }
  }, [variant.id])

  const onHandOk = WHOLE.test(onHand.trim())
  const allocOk = mode === 'shared' || WHOLE.test(allocation.trim())
  const n = onHandOk ? Number(onHand.trim()) : 0
  const a = mode === 'shared' ? null : (allocOk ? Number(allocation.trim()) : 0)
  const split = previewSplit(n, inv.reserved, a)
  // An older DTO without walmartListing is treated as "not listed".
  const listing = variant.walmartListing ?? null
  const unlisted = mode === 'split' && a > 0 && (listing === null || listing.status === 'retired')

  // Send only what changed: resending an untouched field would overwrite a
  // concurrent change to it (e.g. an allocation edited elsewhere) with the
  // value this dialog happened to open with. Invalid text counts as changed so
  // the validation message below still shows.
  const onHandChanged = !onHandOk || n !== inv.onHand
  const allocChanged = !allocOk || a !== inv.walmartAllocation
  const noteText = note.trim()
  const nothingToSave = !onHandChanged && !allocChanged && noteText === ''

  const save = async (expectedOnHand = expected) => {
    if (saving) return
    setError(null)
    if (!onHandOk) { setError('On hand must be a whole number, 0 or more.'); return }
    if (!allocOk) { setError('Walmart allocation must be a whole number, 0 or more.'); return }
    const body = {
      ...(onHandChanged ? { onHand: n } : {}),
      ...(allocChanged ? { walmartAllocation: a } : {}),
      expectedOnHand,
      ...(noteText ? { note: noteText } : {}),
    }
    setSaving(true)
    try {
      onSaved(await api.setStock(variant.id, body))
      onClose()
    } catch (err) {
      if (err.code === 'STOCK_CHANGED') { setConflict(err.details); return }
      // Core's message says what is wrong and what to do (spec §3/§6); the
      // field hints only follow it.
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open title={`Stock — ${variant.sku}`} onClose={onClose} onConfirm={() => save()} confirmLabel="Save stock"
      confirmDisabled={nothingToSave || saving}>
      <div className="space-y-4 text-sm">
        <div>
          <label className="block font-semibold" htmlFor="sd-onhand">On hand</label>
          <input id="sd-onhand" inputMode="numeric" value={onHand} onChange={(e) => setOnHand(e.target.value)}
            className="mt-1 w-32 rounded-lg border border-gray-200 px-2 py-1" />
          <span className="ml-2 text-gray-500">{inv.reserved} reserved by open orders</span>
        </div>

        <fieldset>
          <legend className="font-semibold">Walmart</legend>
          <label className="mr-4"><input type="radio" name="sd-mode" checked={mode === 'shared'} onChange={() => setMode('shared')} /> Shared</label>
          <label><input type="radio" name="sd-mode" checked={mode === 'split'} onChange={() => setMode('split')} /> Split</label>
          <p className="mt-1 text-xs text-gray-500">
            {mode === 'shared' ? 'Both channels sell everything that is not reserved.' : 'Set aside units that only Walmart can sell.'}
          </p>
          {mode === 'split' && (
            <div className="mt-2">
              <label htmlFor="sd-alloc">Walmart allocation</label>
              <input id="sd-alloc" inputMode="numeric" value={allocation} onChange={(e) => setAllocation(e.target.value)}
                className="ml-2 w-20 rounded-lg border border-gray-200 px-2 py-1" />
            </div>
          )}
          {mode === 'shared' && (
            <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-accent">
              A one-off can sell twice: once here and once on Walmart before Walmart hears it is gone.
              Someone must watch for Walmart orders that fail to import and cancel them on Walmart.
            </p>
          )}
          {unlisted && (
            <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-accent">
              This variant isn't listed on Walmart — units allocated to Walmart can't sell anywhere until it is.
            </p>
          )}
        </fieldset>

        <p className="text-gray-600">Storefront can sell <b>{split.storefront}</b> · Walmart can sell <b>{split.walmart}</b></p>

        <div>
          <label className="block font-semibold" htmlFor="sd-note">Note</label>
          <input id="sd-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1" />
        </div>

        {error && <p className="text-accent">{error}</p>}
        {conflict && (
          <div className="rounded-lg bg-gray-100 p-3">
            <p>Stock changed to <b>{conflict.onHand}</b> since you opened this. Set it to {onHand} anyway?</p>
            <Button className="mt-2" disabled={saving} onClick={() => { setExpected(conflict.onHand); setConflict(null); save(conflict.onHand) }}>Set it anyway</Button>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <h4 className="font-semibold">Recent changes</h4>
            <ul className="mt-1 space-y-1 text-xs text-gray-500">
              {history.map((h, i) => (
                <li key={i}>
                  {new Date(h.at).toLocaleString()} · {h.actor} · {h.before?.onHand}→{h.after?.onHand}
                  {h.after?.walmartAllocation !== h.before?.walmartAllocation && ` · Walmart ${h.before?.walmartAllocation ?? 'shared'}→${h.after?.walmartAllocation ?? 'shared'}`}
                  {h.note && ` · ${h.note}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}

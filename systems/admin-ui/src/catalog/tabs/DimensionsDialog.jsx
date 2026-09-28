import { useState } from 'react'
import api from '../../data/api.js'
import Modal from '../../ui/Modal.jsx'
import { errorText } from '../../lib/errorText.js'

const FIELDS = [
  ['weightGrams', 'Weight (g)'], ['lengthMm', 'Length (mm)'], ['widthMm', 'Width (mm)'], ['heightMm', 'Height (mm)'],
]
const WHOLE = /^[1-9]\d*$/

/**
 * Optional shipping physicals (spec §7). Unused until a carrier-rate adapter
 * exists. Sends only changed fields; an emptied field clears to null.
 */
export default function DimensionsDialog({ variant, onClose, onSaved }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map(([k]) => [k, variant[k] == null ? '' : String(variant[k])])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const parsed = Object.fromEntries(FIELDS.map(([k]) => {
    const t = values[k].trim()
    return [k, t === '' ? null : WHOLE.test(t) ? Number(t) : undefined]
  }))
  const valid = Object.values(parsed).every((v) => v !== undefined)
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== (variant[k] ?? null)))

  const save = async () => {
    if (busy || !valid) return
    if (Object.keys(patch).length === 0) { onClose(); return }
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.updateVariant(variant.id, patch))
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={`${variant.sku} — weight and dimensions`} onClose={onClose} onConfirm={save}
      confirmLabel="Save" confirmDisabled={busy || !valid}>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="block">{label}
            <input aria-label={label} inputMode="numeric" value={values[k]}
              onChange={(e) => setValues((s) => ({ ...s, [k]: e.target.value }))}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1" />
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-400">Optional. Used for carrier rates later; flat-rate shipping ignores them.</p>
      {error && <p role="alert" className="mt-2 text-accent">{error}</p>}
    </Modal>
  )
}

import { useRef, useState } from 'react'
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
  // Ref, not just state: setBusy(true) doesn't repaint before a second click
  // in the same tick can land, so the guard against a double-send has to be
  // synchronous.
  const inFlight = useRef(false)

  const parsed = Object.fromEntries(FIELDS.map(([k]) => {
    const t = values[k].trim()
    return [k, t === '' ? null : WHOLE.test(t) ? Number(t) : undefined]
  }))
  const valid = Object.values(parsed).every((v) => v !== undefined)
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== (variant[k] ?? null)))

  const save = async () => {
    if (inFlight.current || !valid) return
    if (Object.keys(patch).length === 0) { onClose(); return }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.updateVariant(variant.id, patch))
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      inFlight.current = false
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

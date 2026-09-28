import { useEffect, useRef, useState } from 'react'
import api from '../data/api.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'
import { dollarsToCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'

const toText = (cents) => (cents / 100).toFixed(2)

/** Spec §7: flat rate and free-shipping threshold (D2's placeholders live here). */
export default function ShippingSettings() {
  const toast = useToast()
  const [loaded, setLoaded] = useState(false)
  const [flat, setFlat] = useState('')
  const [freeOn, setFreeOn] = useState(true)
  const [threshold, setThreshold] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Ref, not just state: setBusy(true) doesn't repaint before a second click
  // in the same tick can land, so the guard against a double-send has to be
  // synchronous.
  const inFlight = useRef(false)

  const apply = (s) => {
    setFlat(toText(s.flatRateCents))
    setFreeOn(s.freeThresholdCents !== null)
    setThreshold(s.freeThresholdCents !== null ? toText(s.freeThresholdCents) : '')
    setLoaded(true)
  }

  useEffect(() => {
    let live = true
    api.getShippingSettings().then((s) => { if (live) apply(s) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [])

  const flatCents = dollarsToCents(flat)
  const thresholdCents = freeOn ? dollarsToCents(threshold) : null
  const valid = flatCents !== null && (!freeOn || (thresholdCents !== null && thresholdCents > 0))

  const save = async () => {
    if (inFlight.current || !valid) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      apply(await api.updateShippingSettings({ flatRateCents: flatCents, freeThresholdCents: thresholdCents }))
      toast.push('Shipping settings saved')
    } catch (e) {
      setError(errorText(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card>
        <h2 className="font-semibold">Shipping</h2>
        {!loaded && !error && <p className="text-sm text-gray-500">Loading…</p>}
        {loaded && (
          <div className="mt-3 space-y-3 text-sm">
            <label className="block">Flat rate per order ($)
              <input aria-label="Flat rate per order ($)" value={flat} onChange={(e) => setFlat(e.target.value)}
                className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={freeOn} onChange={(e) => setFreeOn(e.target.checked)} />
              Offer free shipping
            </label>
            {freeOn && (
              <label className="block">Free shipping at or above ($)
                <input aria-label="Free shipping at or above ($)" value={threshold} onChange={(e) => setThreshold(e.target.value)}
                  className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1" />
              </label>
            )}
            <p className="text-xs text-gray-400">Applies to checkouts started after saving. Contiguous US only.</p>
            <Button onClick={save} disabled={busy || !valid}>Save</Button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-accent">{error}</p>}
      </Card>
    </div>
  )
}

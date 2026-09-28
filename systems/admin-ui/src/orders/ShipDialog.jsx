import { useRef, useState } from 'react'
import api from '../data/api.js'
import Modal from '../ui/Modal.jsx'
import { errorText } from '../lib/errorText.js'
import { REVIEW_LABELS } from './labels.js'

const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other']

/** Spec §7: carrier + tracking (required unless Other) -> core fulfils.
 * A flagged order (any reviewReason) needs acknowledgeReview: true or core
 * 409s REVIEW_REQUIRED (F-R3 re-checks under the row lock, but the console
 * still gates the button so a normal ship isn't a guessing game). */
export default function ShipDialog({ order, onClose, onShipped }) {
  const [carrier, setCarrier] = useState('USPS')
  const [tracking, setTracking] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Ref, not just state: setBusy(true) doesn't repaint before a second click
  // in the same tick can land, so the guard against a double-send has to be
  // synchronous.
  const inFlight = useRef(false)
  const flagged = Boolean(order.reviewReason)
  const trackingOk = carrier === 'Other' || tracking.trim() !== ''
  const valid = trackingOk && (!flagged || ack)

  const submit = async () => {
    if (inFlight.current || !valid) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      onShipped(await api.shipOrder(order.id, {
        carrier,
        ...(tracking.trim() ? { trackingNumber: tracking.trim() } : {}),
        ...(flagged ? { acknowledgeReview: true } : {}),
      }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal open title={`Mark ${order.orderNumber} shipped`} onClose={onClose} onConfirm={submit}
      confirmLabel="Mark shipped" confirmDisabled={busy || !valid}>
      <div className="space-y-3">
        <label className="block">Carrier
          <select aria-label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1">
            {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">Tracking number {carrier === 'Other' && <span className="text-gray-400">(optional)</span>}
          <input aria-label="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1 font-mono" />
        </label>
        {flagged && (
          <label className="flex items-start gap-2 text-accent">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>This order is flagged ({REVIEW_LABELS[order.reviewReason] ?? order.reviewReason}). I have reviewed it and it should ship.</span>
          </label>
        )}
        {error && <p role="alert" className="text-accent">{error}</p>}
      </div>
    </Modal>
  )
}

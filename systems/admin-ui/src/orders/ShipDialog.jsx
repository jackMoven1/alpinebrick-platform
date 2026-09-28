import { useRef, useState } from 'react'
import api from '../data/api.js'
import Modal from '../ui/Modal.jsx'
import { errorText } from '../lib/errorText.js'
import { REVIEW_LABELS } from './labels.js'

// Must match core's CARRIERS in systems/core/src/admin/admin-orders.service.ts.
const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other']

/** Spec §7: carrier + tracking (required unless Other) -> core fulfils.
 * A flagged order (any reviewReason) needs acknowledgeReview: true or core
 * 409s REVIEW_REQUIRED (F-R3 re-checks under the row lock, but the console
 * still gates the button so a normal ship isn't a guessing job). */
export default function ShipDialog({ order, onClose, onShipped }) {
  const [carrier, setCarrier] = useState('USPS')
  const [tracking, setTracking] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // The order's reviewReason can arrive late: core's row-locked re-check in
  // fulfillOrder can flag an order that looked clean when this dialog opened
  // (a sweep or another admin action lands in between). When that 409 comes
  // back, reviewReason lives here instead of on the `order` prop so the
  // acknowledgement checkbox can still appear.
  const [lateReviewReason, setLateReviewReason] = useState(null)
  // Ref, not just state: setBusy(true) doesn't repaint before a second click
  // in the same tick can land, so the guard against a double-send has to be
  // synchronous.
  const inFlight = useRef(false)
  const reviewReason = order.reviewReason ?? lateReviewReason
  const flagged = Boolean(reviewReason)
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
      if (e?.code === 'REVIEW_REQUIRED' && !flagged) {
        if (e.details?.reviewReason) {
          setLateReviewReason(e.details.reviewReason)
        } else {
          api.getOrder(order.id)
            .then((o) => setLateReviewReason(o.reviewReason ?? 'flagged'))
            .catch(() => {})
        }
      }
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
            <span>This order is flagged ({REVIEW_LABELS[reviewReason] ?? reviewReason}). I have reviewed it and it should ship.</span>
          </label>
        )}
        {error && <p role="alert" className="text-accent">{error}</p>}
      </div>
    </Modal>
  )
}

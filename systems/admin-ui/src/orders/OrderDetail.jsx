import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../data/api.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'
import Modal from '../ui/Modal.jsx'
import { useToast } from '../ui/toast.jsx'
import { formatCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'
import { REVIEW_LABELS, STATUS_LABELS } from './labels.js'
import ShipDialog from './ShipDialog.jsx'

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US') : '—')

export default function OrderDetail() {
  const { id } = useParams()
  const toast = useToast()
  const [order, setOrder] = useState(null)
  const [error, setError] = useState(null)
  const [shipping, setShipping] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelAck, setCancelAck] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState(null)
  // Ref guard: same reasoning as ShipDialog -- a double click before the
  // first setCancelling(true) repaints must not fire cancelOrder twice.
  const cancelInFlight = useRef(false)

  useEffect(() => {
    let live = true
    api.getOrder(id).then((o) => { if (live) setOrder(o) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [id])

  if (!order) return error ? <p role="alert" className="text-accent">{error}</p> : <p className="text-gray-500">Loading…</p>

  // Core (F-R1): cancel is allowed on a pending order, or on a paid order
  // whose reviewReason is 'disputed' -- and only with acknowledgeReview: true
  // on that second path (409 REVIEW_REQUIRED otherwise). Every other paid
  // order is refused, so no Cancel button is offered for it -- a refund goes
  // through the Stripe dashboard instead.
  const requiresAckToCancel = order.status === 'paid' && order.reviewReason === 'disputed'
  const canCancel = order.status === 'pending' || requiresAckToCancel

  const openCancel = () => {
    setCancelAck(false)
    setCancelError(null)
    setConfirmCancel(true)
  }

  const cancel = async () => {
    if (cancelInFlight.current || (requiresAckToCancel && !cancelAck)) return
    cancelInFlight.current = true
    setCancelling(true)
    setCancelError(null)
    try {
      const updated = requiresAckToCancel
        ? await api.cancelOrder(order.id, { acknowledgeReview: true })
        : await api.cancelOrder(order.id)
      setOrder(updated)
      toast.push('Order cancelled')
      setConfirmCancel(false)
    } catch (e) {
      setCancelError(errorText(e))
      // ORDER_PAID: the customer paid while the confirm dialog was open.
      // INVALID_TRANSITION: the order moved on (e.g. someone else acted on
      // it) between load and confirm. Either way the status and Cancel
      // button shown behind the modal are stale -- refresh them.
      if (e?.code === 'ORDER_PAID' || e?.code === 'INVALID_TRANSITION') {
        api.getOrder(order.id).then(setOrder).catch(() => {})
      }
    } finally {
      cancelInFlight.current = false
      setCancelling(false)
    }
  }

  // Tax and total are unresolved while Stripe Tax hasn't run yet (spec:
  // taxJurisdiction === 'stripe_tax_pending', or any future '*_pending'
  // jurisdiction) -- showing $0.00 would read as "this order owes no tax".
  const taxPending = Boolean(order.taxJurisdiction) && order.taxJurisdiction.endsWith('_pending')
  // Every row is a pre-formatted display string, not a raw cent integer --
  // Tax/Total need to fall back to "pending"/"pending tax" instead of
  // formatCents, so the whole array has to agree on the string contract.
  const money = [
    ['Subtotal', formatCents(order.subtotalCents)],
    ['Shipping', formatCents(order.shippingCents)],
    ['Tax', taxPending ? 'pending' : formatCents(order.taxCents)],
    ['Total', taxPending ? 'pending tax' : formatCents(order.totalCents)],
  ]

  return (
    <div className="space-y-6">
      <Link to="/orders" className="text-sm text-gray-500">← Orders</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">Order {order.orderNumber}</h1>
        <Pill>{STATUS_LABELS[order.status] ?? order.status}</Pill>
        {order.reviewReason && <Pill>{REVIEW_LABELS[order.reviewReason] ?? order.reviewReason}</Pill>}
        <div className="ml-auto flex gap-2">
          {order.status === 'paid' && <Button onClick={() => setShipping(true)}>Mark shipped</Button>}
          {canCancel && <Button variant="danger" onClick={openCancel}>Cancel order</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-accent">{error}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="font-semibold">Items</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {order.lines.map((l) => (
              <li key={l.variantId} className="flex justify-between gap-4">
                <span><span>{l.name}</span> <span className="font-mono text-gray-400">{l.sku}</span> × {l.quantity}</span>
                <span>{formatCents(l.lineSubtotalCents)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1 text-sm">
            {money.map(([k, v]) => <div key={k} className="flex justify-between"><dt>{k}</dt><dd>{v}</dd></div>)}
            {order.refundedCents > 0 && <div className="flex justify-between text-accent"><dt>Refunded</dt><dd>{formatCents(order.refundedCents)}</dd></div>}
          </dl>
          {order.stripePaymentUrl && (
            <a href={order.stripePaymentUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold">View payment in Stripe</a>
          )}
          <p className="mt-2 text-xs text-gray-400">Refunds are issued in the Stripe dashboard.</p>
        </Card>

        <Card>
          <h2 className="font-semibold">Customer</h2>
          <p className="mt-2 text-sm">{order.email ?? '—'}</p>
          {order.shipTo ? (
            <address className="mt-2 text-sm not-italic">
              <div>{order.shipTo.name}</div>
              <div>{order.shipTo.line1}</div>
              {order.shipTo.line2 && <div>{order.shipTo.line2}</div>}
              <div>{order.shipTo.city}, {order.shipTo.state} {order.shipTo.postalCode}</div>
            </address>
          ) : <p className="mt-2 text-sm text-gray-400">No address yet.</p>}
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Placed</dt><dd>{when(order.createdAt)}</dd></div>
            <div className="flex justify-between"><dt>Paid</dt><dd>{when(order.paidAt)}</dd></div>
            {/* "Shipped at", not "Shipped": the status pill owns the word "Shipped". */}
            <div className="flex justify-between"><dt>Shipped at</dt><dd>{when(order.shippedAt)}</dd></div>
            {order.carrier && <div className="flex justify-between"><dt>Carrier</dt><dd>{order.carrier} {order.trackingNumber}</dd></div>}
            <div className="flex justify-between"><dt>Referral</dt><dd>{
              !order.referral ? '—'
                : order.referral.unmatched ? <span>{order.referral.code} · <span>unmatched</span></span>
                  // A pending (or swept) order's referral hasn't been resolved
                  // against the partner table yet -- core only does that once
                  // the order is paid -- so partnerName/commissionRateBps are
                  // still null without the code being unmatched.
                  : order.referral.partnerName == null ? `${order.referral.code} · resolves when paid`
                    : `${order.referral.code} · ${order.referral.partnerName} · ${(order.referral.commissionRateBps / 100).toFixed(2)}%`
            }</dd></div>
          </dl>
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold">History</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {order.audit.map((a, i) => (
            <li key={i} className="flex gap-4"><span className="w-48 text-gray-500">{when(a.createdAt)}</span><span className="font-mono">{a.action}</span><span className="text-gray-500">{a.actorName}</span></li>
          ))}
        </ul>
      </Card>

      {shipping && (
        <ShipDialog order={order} onClose={() => setShipping(false)}
          onShipped={(o) => { setOrder(o); setShipping(false); toast.push('Order marked shipped') }} />
      )}
      <Modal open={confirmCancel} title={`Cancel ${order.orderNumber}?`} danger confirmLabel="Cancel order"
        dismissLabel={requiresAckToCancel ? 'Keep order' : 'Cancel'}
        confirmDisabled={cancelling || (requiresAckToCancel && !cancelAck)}
        onClose={() => setConfirmCancel(false)} onConfirm={cancel}>
        <p>{requiresAckToCancel
          ? 'This cancels the order and returns the items to stock. Any refund happens in the payment dashboard.'
          : "This closes the customer's Stripe checkout and returns the items to stock."}</p>
        {requiresAckToCancel && (
          <label className="mt-3 flex items-start gap-2 text-accent">
            <input type="checkbox" checked={cancelAck} onChange={(e) => setCancelAck(e.target.checked)} />
            <span>This order is disputed. I have reviewed it and it should still be cancelled.</span>
          </label>
        )}
        {cancelError && <p role="alert" className="mt-3 text-accent">{cancelError}</p>}
      </Modal>
    </div>
  )
}

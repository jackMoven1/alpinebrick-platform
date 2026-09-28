import { Link } from 'react-router'
import type { CheckoutStatus } from '../../lib/api/checkout'
import { formatCents } from '../../lib/money'

/** No provider name, and no receipt promise until spec §9.1 is settled (plan decision 12). */
export const RECEIPT_NOTE = 'Keep your order number for your reference.'

/** Shared by /checkout (from the pay response) and /order/complete (from the status poll). */
export default function OrderConfirmation({ status }: { status: CheckoutStatus }) {
  const { orderNumber, lines, totals } = status
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]">{`Order ${orderNumber} confirmed`}</h1>
      <ul className="divide-y divide-border text-sm">
        {lines.map((l) => (
          <li key={l.sku} className="py-3 flex justify-between">
            <span>{l.name} × {l.quantity}</span><span>{formatCents(l.lineSubtotalCents)}</span>
          </li>
        ))}
      </ul>
      <dl className="text-sm space-y-1">
        <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatCents(totals.subtotalCents)}</dd></div>
        <div className="flex justify-between"><dt>Shipping</dt><dd>{formatCents(totals.shippingCents)}</dd></div>
        <div className="flex justify-between"><dt>Tax</dt><dd>{formatCents(totals.taxCents)}</dd></div>
        <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatCents(totals.totalCents)}</dd></div>
      </dl>
      <p className="text-sm text-muted-foreground">{RECEIPT_NOTE}</p>
      <Link to="/collections" className="underline text-sm">Keep browsing</Link>
    </div>
  )
}

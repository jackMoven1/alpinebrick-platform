import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getCheckoutStatus, CheckoutError, type CheckoutStatus } from '../lib/api/checkout'
import { useCart } from '../lib/cart/CartContext'
import { clearPreviousOrderId } from '../lib/checkout/previousOrder'
import { formatCents } from '../lib/money'

export const POLL_INTERVAL_MS = 1500
export const POLL_LIMIT_MS = 20_000

type View =
  | { kind: 'loading' }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'slow' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'order_not_found' }

const heading = 'text-3xl font-black uppercase tracking-[0.05em]'

/** Spec §6: poll core every 1.5 s for up to 20 s after Stripe's redirect. */
export default function OrderComplete() {
  const [params] = useSearchParams()
  const sessionId = params.get('session_id')
  const { clear } = useCart()
  const [view, setView] = useState<View>(sessionId ? { kind: 'loading' } : { kind: 'missing' })

  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const tick = async () => {
      try {
        const s = await getCheckoutStatus(sessionId)
        if (stopped) return
        if (s.status === 'paid') {
          clear()
          clearPreviousOrderId()
          setView({ kind: 'paid', status: s })
          return
        }
        if (s.status === 'cancelled') {
          setView({ kind: 'expired' })
          return
        }
      } catch (err) {
        if (stopped) return
        // Ruling P10: core's `not_found` is a terminal answer, not a blip --
        // the order genuinely doesn't exist, so don't fold it into the
        // pending/"confirming" state and don't keep retrying forever.
        if (err instanceof CheckoutError && err.code === 'not_found') {
          setView({ kind: 'order_not_found' })
          return
        }
        // Any other blip is not an answer; keep polling until the limit.
      }
      if (Date.now() - started >= POLL_LIMIT_MS) {
        setView({ kind: 'slow' })
        return
      }
      timer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, clear])

  const wrap = (children: ReactNode) => (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>{children}</div>
  )

  switch (view.kind) {
    case 'loading':
      return wrap(<p className="text-sm text-muted-foreground">Confirming your order…</p>)
    case 'missing':
      return wrap(<>
        <h1 className={heading}>We couldn't find that checkout</h1>
        <Link to="/cart" className="underline text-sm">Back to cart</Link>
      </>)
    case 'order_not_found':
      return wrap(<>
        <h1 className={heading}>We couldn't find that order</h1>
        <Link to="/cart" className="underline text-sm">Back to cart</Link>
      </>)
    case 'expired':
      return wrap(<>
        <h1 className={heading}>This checkout expired</h1>
        <Link to="/cart" className="underline text-sm">Back to cart</Link>
      </>)
    case 'slow':
      return wrap(<p className="text-sm">Payment received — we're confirming your order. Your Stripe receipt is your confirmation.</p>)
    case 'paid': {
      const { orderNumber, lines, totals } = view.status
      return wrap(<>
        <h1 className={heading}>{`Order ${orderNumber} confirmed`}</h1>
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
        <p className="text-sm text-muted-foreground">Your receipt is on its way from Stripe</p>
        <Link to="/collections" className="underline text-sm">Keep browsing</Link>
      </>)
    }
  }
}

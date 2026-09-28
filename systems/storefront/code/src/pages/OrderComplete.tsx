import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getCheckoutStatus, CheckoutError, type CheckoutStatus } from '../lib/api/checkout'
import { useCart } from '../lib/cart/CartContext'
import { clearPreviousOrderId } from '../lib/checkout/previousOrder'
import OrderConfirmation from '../components/checkout/OrderConfirmation'

export const POLL_INTERVAL_MS = 1500
export const POLL_LIMIT_MS = 20_000
export const SLOW_MESSAGE = "We're confirming your payment. Please don't pay again — refresh this page in a few minutes."

type View =
  | { kind: 'loading' }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'slow' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'order_not_found' }

const heading = 'text-3xl font-black uppercase tracking-[0.05em]'

/**
 * Spec §2 step 6: reloads and the processing state. Polls core by order id
 * every 1.5 s for up to 20 s. The pay response itself confirms most orders
 * on /checkout; this page is reached after a `processing` or
 * `payment_pending` answer, when money is probably in flight -- so, as
 * before (Jack, 2026-09-27), the slow state clears the cart too. It is not
 * cleared on `cancelled` or `not_found`: nothing was bought.
 */
export default function OrderComplete() {
  const [params] = useSearchParams()
  const orderId = params.get('order')
  const { clear } = useCart()
  const [view, setView] = useState<View>(orderId ? { kind: 'loading' } : { kind: 'missing' })

  useEffect(() => {
    if (!orderId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const forgetCart = () => {
      clear()
      clearPreviousOrderId()
    }
    const tick = async () => {
      try {
        const s = await getCheckoutStatus(orderId)
        if (stopped) return
        if (s.status === 'paid') {
          forgetCart()
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
        forgetCart()
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
  }, [orderId, clear])

  const wrap = (children: ReactNode) => (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>{children}</div>
  )

  switch (view.kind) {
    case 'loading':
      return wrap(<p className="text-sm text-muted-foreground">Confirming your order…</p>)
    case 'missing':
      return wrap(<><h1 className={heading}>We couldn't find that checkout</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'order_not_found':
      return wrap(<><h1 className={heading}>We couldn't find that order</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'expired':
      return wrap(<><h1 className={heading}>This checkout expired</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'slow':
      return wrap(<p className="text-sm">{SLOW_MESSAGE}</p>)
    case 'paid':
      return <OrderConfirmation status={view.status} />
  }
}

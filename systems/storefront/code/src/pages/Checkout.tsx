import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js'
import { getStripe } from '../lib/stripe'
import { setPreviousOrderId } from '../lib/checkout/previousOrder'
import { UNAVAILABLE_MESSAGE } from '../lib/api/checkout'
import { CONTIGUOUS_NOTICE } from '../components/cart/CartPanel'
import { PageHeader } from '../components/PageHeader'

interface CheckoutState { clientSecret?: string; orderId?: string; expiresAt?: number }

const isPast = (deadline: number | undefined) => deadline !== undefined && Date.now() >= deadline

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 text-center space-y-6">
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]" style={{ fontFamily: 'var(--font-display)' }}>{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Link to="/cart" className="inline-block underline text-sm">Back to cart</Link>
    </div>
  )
}

/** Spec §6 / D7: Stripe Embedded Checkout on our own page. */
export default function Checkout() {
  const state = (useLocation().state ?? null) as CheckoutState | null
  const clientSecret = state?.clientSecret
  const orderId = state?.orderId
  const expiresAt = state?.expiresAt
  // Once per mount: a failed load resets getStripe's memo, and calling it on
  // every render would re-attempt the load on each one.
  const [stripe] = useState(getStripe)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (orderId) setPreviousOrderId(orderId)
  }, [orderId])

  useEffect(() => {
    let live = true
    stripe?.then(
      (s) => { if (live && !s) setLoadFailed(true) },
      () => { if (live) setLoadFailed(true) },
    )
    return () => { live = false }
  }, [stripe])

  // The checkout state lives in the history entry, so a reload or a return
  // to a backgrounded tab redraws the form long after Stripe expired the
  // session -- and a payment there fails. Swap the form out at the deadline.
  // The timer alone is not enough: browsers throttle or freeze timers in
  // background tabs and across sleep, so re-check whenever the tab is shown.
  const [expired, setExpired] = useState(() => isPast(expiresAt))
  useEffect(() => {
    if (expiresAt === undefined) return
    const check = () => { if (isPast(expiresAt)) setExpired(true) }
    check()
    const timer = window.setTimeout(check, Math.max(0, expiresAt - Date.now()))
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [expiresAt])

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret ?? ''), [clientSecret])

  if (!clientSecret) return <Problem title="Your checkout has ended" body="Start again from your cart." />
  if (expired) {
    return <Problem title="Your checkout timed out" body="We held your items while you paid, and that hold has ended. Start again from your cart." />
  }
  if (!stripe || loadFailed) return <Problem title="We couldn't load the payment form" body={UNAVAILABLE_MESSAGE} />

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-8">
      <PageHeader eyebrow="Checkout" title="Payment" intro={CONTIGUOUS_NOTICE} />
      <div id="checkout">
        <EmbeddedCheckoutProvider stripe={stripe} options={{ fetchClientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
      <p className="text-xs text-muted-foreground">
        By paying you agree to our <Link to="/legal/terms" className="underline">Terms</Link> and{' '}
        <Link to="/legal/privacy" className="underline">Privacy</Link> policy. See our{' '}
        <Link to="/support/returns" className="underline">Refund</Link> and{' '}
        <Link to="/support/shipping" className="underline">Shipping</Link> policies.
      </p>
    </div>
  )
}

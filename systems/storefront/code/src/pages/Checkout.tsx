import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js'
import { getStripe } from '../lib/stripe'
import { setPreviousOrderId } from '../lib/checkout/previousOrder'
import { UNAVAILABLE_MESSAGE } from '../lib/api/checkout'
import { CONTIGUOUS_NOTICE } from '../components/cart/CartPanel'
import { PageHeader } from '../components/PageHeader'

interface CheckoutState { clientSecret?: string; orderId?: string }

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
  const stripe = getStripe()
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

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret ?? ''), [clientSecret])

  if (!clientSecret) return <Problem title="Your checkout has ended" body="Start again from your cart." />
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

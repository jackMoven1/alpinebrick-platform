import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  quoteCheckout, payCheckout, CheckoutError, UNAVAILABLE_MESSAGE, type CheckoutStatus, type Quote, type QuoteRequest,
} from '../lib/api/checkout'
import { squareConfig } from '../lib/square'
import { setPreviousOrderId, clearPreviousOrderId } from '../lib/checkout/previousOrder'
import { useCart } from '../lib/cart/CartContext'
import { formatCents } from '../lib/money'
import { CONTIGUOUS_NOTICE } from '../components/cart/CartPanel'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../design-system/primitives'
import AddressForm, { EMPTY_QUOTE_REQUEST, type AddressField, type FieldErrors } from '../components/checkout/AddressForm'
import SquarePayment from '../components/checkout/SquarePayment'
import OrderConfirmation from '../components/checkout/OrderConfirmation'

/**
 * The quote travels as one value: the amount the card form shows and the
 * quoteVersion pay sends always come from the same quote response.
 */
type Step =
  | { kind: 'address' }
  | { kind: 'pay'; quote: Quote }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'expired'; body: string }

/** Friendly copy for a field core refused with 400 invalid_request (Q-P11). */
const FIELD_COPY: Record<AddressField, string> = {
  email: 'Enter a valid email address',
  name: 'Enter your full name',
  'address.line1': 'Enter your street address',
  'address.line2': 'Keep address line 2 to 100 characters or fewer',
  'address.city': 'Enter your city',
  'address.state': 'Choose a state',
  'address.postalCode': 'Enter a 5-digit ZIP code',
}

function isAddressField(f: string | null): f is AddressField {
  return f !== null && Object.prototype.hasOwnProperty.call(FIELD_COPY, f)
}

/** The per-field message for a refused quote, or null when core named no field we show. */
function fieldError(err: CheckoutError): FieldErrors | null {
  if (!isAddressField(err.field)) return null
  if (err.code === 'outside_shipping_area') return { [err.field]: CONTIGUOUS_NOTICE }
  if (err.code === 'invalid_request') return { [err.field]: FIELD_COPY[err.field] }
  return null
}

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 text-center space-y-6">
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]" style={{ fontFamily: 'var(--font-display)' }}>{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Link to="/cart" className="inline-block underline text-sm">Back to cart</Link>
    </div>
  )
}

function Summary({ quote }: { quote: Quote }) {
  const rows: [string, number][] = [
    ['Subtotal', quote.subtotalCents], ['Shipping', quote.shippingCents], ['Tax', quote.taxCents], ['Total', quote.totalCents],
  ]
  return (
    <ul aria-label="Order total" className="text-sm space-y-1">
      {rows.map(([label, cents]) => (
        <li key={label} className={`flex justify-between ${label === 'Total' ? 'font-semibold' : ''}`}>
          <span>{label}</span><span>{formatCents(cents)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Spec §2 steps 2-6 on our own page (Q6): address -> quote -> Square card
 * form and wallets -> confirmation from the pay response.
 * /order/complete is only for reloads and the processing state.
 */
export default function Checkout() {
  const orderId = (useLocation().state as { orderId?: string } | null)?.orderId
  const navigate = useNavigate()
  const { clear } = useCart()
  const [config] = useState(squareConfig)
  const [form, setForm] = useState<QuoteRequest>(EMPTY_QUOTE_REQUEST)
  const [step, setStep] = useState<Step>({ kind: 'address' })
  const [busy, setBusy] = useState(false)
  // true while SquarePayment holds its pay lock (tokenizing, then our pay call).
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [notice, setNotice] = useState<string | null>(null)
  // The token of an attempt whose outcome is unknown: Try again re-sends it,
  // so core reuses the idempotency key and Square replays (plan decision 3).
  const [retryToken, setRetryToken] = useState<string | null>(null)
  // Guards against a second pay call before React re-renders `busy`.
  const inFlight = useRef(false)

  useEffect(() => {
    if (orderId) setPreviousOrderId(orderId)
  }, [orderId])

  if (!orderId) return <Problem title="Your checkout has ended" body="Start again from your cart." />
  if (!config) return <Problem title="We couldn't load the payment form" body={UNAVAILABLE_MESSAGE} />
  if (step.kind === 'expired') return <Problem title="This checkout expired" body={step.body} />
  if (step.kind === 'paid') return <OrderConfirmation status={step.status} />
  const id = orderId
  const complete = () => navigate(`/order/complete?order=${encodeURIComponent(id)}`)
  // Q-P1: core may be charging. No re-quote (Edit address) and no new card
  // until the outcome is known; an unknown outcome is resolved by Try again.
  const charging = busy || paying || retryToken !== null

  /** Everything but the codes each caller handles itself. */
  function show(err: unknown) {
    if (!(err instanceof CheckoutError)) { setError(UNAVAILABLE_MESSAGE); return }
    if (err.code === 'order_expired' || err.code === 'not_found') { setStep({ kind: 'expired', body: 'Start again from your cart.' }); return }
    if (err.code === 'too_many_attempts') { setStep({ kind: 'expired', body: err.message }); return }
    if (err.code === 'payment_pending') { complete(); return }
    const fields = fieldError(err)
    if (fields) {
      // The address is what core refused: back to the form, message by the field.
      setStep({ kind: 'address' })
      setNotice(null)
      setFieldErrors(fields)
      return
    }
    setError(err.message)
  }

  async function quote(): Promise<Quote | null> {
    try {
      return await quoteCheckout(id, { ...form, address: { ...form.address, country: 'US' } })
    } catch (err) {
      show(err)
      return null
    }
  }

  async function submitAddress() {
    if (busy) return
    setBusy(true)
    setError(null)
    setFieldErrors({})
    setNotice(null)
    const q = await quote()
    setBusy(false)
    if (q) setStep({ kind: 'pay', quote: q })
  }

  /** Returned to SquarePayment as-is, so its pay lock lasts until this settles. */
  async function pay(token: string): Promise<void> {
    if (inFlight.current || step.kind !== 'pay') return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    setRetryToken(null)
    try {
      const result = await payCheckout(id, { sourceToken: token, quoteVersion: step.quote.quoteVersion })
      if (result.status === 'paid') {
        clear()
        clearPreviousOrderId()
        setStep({ kind: 'paid', status: result })
      } else {
        complete()
      }
    } catch (err) {
      if (err instanceof CheckoutError && err.code === 'quote_changed') {
        // Core refused before charging; replace amount and version together.
        const q = await quote()
        if (q) {
          setStep({ kind: 'pay', quote: q })
          setNotice(`Your total changed to ${formatCents(q.totalCents)} — check it and pay again.`)
        }
      } else if (err instanceof CheckoutError && err.code === 'checkout_unavailable') {
        setRetryToken(token)
        setError(UNAVAILABLE_MESSAGE)
      } else {
        show(err)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function editAddress() {
    if (charging) return
    setStep({ kind: 'address' })
    setError(null)
    setNotice(null)
  }

  const alert = error && <p role="alert" className="text-sm text-destructive">{error}</p>

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-8">
      <PageHeader eyebrow="Checkout" title={step.kind === 'address' ? 'Shipping' : 'Payment'} intro={CONTIGUOUS_NOTICE} />
      {step.kind === 'address' ? (
        <div className="space-y-4">
          <AddressForm value={form} onChange={setForm} onSubmit={() => { void submitAddress() }} busy={busy} errors={fieldErrors} />
          {alert}
        </div>
      ) : (
        <div className="space-y-6">
          <Summary quote={step.quote} />
          <button type="button" className="underline text-sm disabled:opacity-50 disabled:no-underline" disabled={charging}
            onClick={editAddress}>
            Edit address
          </button>
          {notice && <p role="status" className="text-sm font-semibold">{notice}</p>}
          <SquarePayment config={config} amountCents={step.quote.totalCents} contact={form}
            disabled={busy || retryToken !== null} onToken={(t) => pay(t)} onPayingChange={setPaying} />
          {alert}
          {retryToken && (
            <Button className="w-full" disabled={busy || paying} onClick={() => { void pay(retryToken) }}>Try again</Button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        By paying you agree to our <Link to="/legal/terms" className="underline">Terms</Link> and{' '}
        <Link to="/legal/privacy" className="underline">Privacy</Link> policy. See our{' '}
        <Link to="/support/returns" className="underline">Refund</Link> and{' '}
        <Link to="/support/shipping" className="underline">Shipping</Link> policies.
      </p>
    </div>
  )
}

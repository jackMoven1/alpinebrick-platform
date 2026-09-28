import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  quoteCheckout, payCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE,
  type Quote, type QuoteRequest,
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

/**
 * The quote travels as one value: the amount the card form shows and the
 * quoteVersion pay sends always come from the same quote response.
 */
type Step =
  | { kind: 'checking' }
  | { kind: 'address' }
  | { kind: 'pay'; quote: Quote }
  | { kind: 'ended'; title: string; body: string }

const EXPIRED: Step = { kind: 'ended', title: 'This checkout expired', body: 'Start again from your cart.' }
const NOT_FOUND: Step = { kind: 'ended', title: "We couldn't find that order", body: 'Start again from your cart.' }

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

/** For a refusal naming no address field (or developer wording): never show core's text. */
const GENERIC_PROBLEM = 'Something went wrong — start again from your cart.'

/**
 * Pay outcomes that settle the attempt. Anything else (rate_limited, an
 * unexpected error) leaves an unknown outcome unknown, so the Try again lock
 * must stay. checkout_unavailable is handled separately in `pay`: it settles
 * only when core marks it a definite failure (err.outcome === 'failed').
 */
const SETTLES_ATTEMPT: ReadonlySet<string> = new Set([
  'payment_declined', 'quote_changed', 'order_expired', 'not_found', 'too_many_attempts', 'payment_pending',
])

function fieldValue(q: QuoteRequest, f: AddressField): string {
  if (f === 'email') return q.email
  if (f === 'name') return q.name
  return q.address[f.slice('address.'.length) as keyof QuoteRequest['address']] ?? ''
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
 * form and wallets. A paid order replaces this page with /order/complete,
 * which renders the confirmation and survives a reload (Ruling S-F1).
 */
export default function Checkout() {
  const orderId = (useLocation().state as { orderId?: string } | null)?.orderId
  const navigate = useNavigate()
  const { clear } = useCart()
  const [config] = useState(squareConfig)
  const [form, setForm] = useState<QuoteRequest>(EMPTY_QUOTE_REQUEST)
  const [step, setStep] = useState<Step>({ kind: 'checking' })
  const [busy, setBusy] = useState(false)
  // true while SquarePayment holds its pay lock (tokenizing, then our pay call).
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  // Bumped when core refuses a field, so the form focuses the first invalid one.
  const [focusRequest, setFocusRequest] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  // The token of an attempt whose outcome is unknown: Try again re-sends it,
  // so core reuses the idempotency key and Square replays (plan decision 3).
  const [retryToken, setRetryToken] = useState<string | null>(null)
  // Guards against a second pay call before React re-renders `busy`.
  const inFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const shownStep = useRef<Step['kind']>(step.kind)

  useEffect(() => {
    if (orderId) setPreviousOrderId(orderId)
  }, [orderId])

  /** A paid order is confirmed on /order/complete; replace, so Back and a reload stay there. */
  const completePaid = useCallback((id: string) => {
    clear()
    clearPreviousOrderId()
    navigate(`/order/complete?order=${encodeURIComponent(id)}`, { replace: true })
  }, [clear, navigate])

  // History state carries the orderId through a refresh, back/forward, or a
  // reload of a finished checkout: ask core once where this order stands
  // before showing a form (Ruling S-F1).
  useEffect(() => {
    if (!orderId || !config) return
    let live = true
    void (async () => {
      try {
        const status = await getCheckoutStatus(orderId)
        if (!live) return
        if (status.status === 'paid') completePaid(orderId)
        else setStep(status.status === 'cancelled' ? EXPIRED : { kind: 'address' })
      } catch (err) {
        if (!live) return
        if (err instanceof CheckoutError && err.code === 'not_found') {
          setStep(NOT_FOUND)
          return
        }
        // Not an answer (network, rate limit, core down): the form is the safe default.
        console.error('Checkout status check failed', err)
        setStep({ kind: 'address' })
      }
    })()
    return () => { live = false }
  }, [orderId, config, completePaid])

  // Moving from the address to the payment step: focus the step's heading.
  useEffect(() => {
    if (shownStep.current === 'address' && step.kind === 'pay') heading.current?.focus()
    shownStep.current = step.kind
  }, [step.kind])

  if (!orderId) return <Problem title="Your checkout has ended" body="Start again from your cart." />
  if (!config) return <Problem title="We couldn't load the payment form" body={UNAVAILABLE_MESSAGE} />
  if (step.kind === 'ended') return <Problem title={step.title} body={step.body} />
  if (step.kind === 'checking') {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24">
        <p role="status" className="text-sm text-muted-foreground">Loading your checkout…</p>
      </div>
    )
  }
  const id = orderId
  const complete = () => navigate(`/order/complete?order=${encodeURIComponent(id)}`)
  // Q-P1: core may be charging. No re-quote (Edit address) and no new card
  // until the outcome is known; an unknown outcome is resolved by Try again.
  const charging = busy || paying || retryToken !== null

  /**
   * Everything but the codes each caller handles itself.
   *
   * The mount check covers a reload of a paid order; this covers an order
   * that paid after the page loaded (another tab): core then refuses with
   * order_expired or not_found even though money changed hands. Rather than
   * show "This checkout expired" on a paid order, check status once -- if
   * paid, go to the confirmation; otherwise it really is expired.
   */
  async function show(err: unknown) {
    if (!(err instanceof CheckoutError)) { setError(UNAVAILABLE_MESSAGE); return }
    if (err.code === 'order_expired' || err.code === 'not_found') {
      try {
        const status = await getCheckoutStatus(id)
        if (status.status === 'paid') { completePaid(id); return }
      } catch (statusErr) {
        // Best-effort here: the refusal itself stands, so fall through to expired.
        console.error('Checkout status check failed', statusErr)
      }
      setStep(EXPIRED)
      return
    }
    if (err.code === 'too_many_attempts') { setStep({ kind: 'ended', title: 'Too many payment attempts', body: err.message }); return }
    if (err.code === 'payment_pending') { complete(); return }
    const fields = fieldError(err)
    if (fields) {
      // The address is what core refused: back to the form, message by the field.
      setStep({ kind: 'address' })
      setNotice(null)
      setFieldErrors(fields)
      setFocusRequest((n) => n + 1)
      return
    }
    setError(err.code === 'invalid_request' ? GENERIC_PROBLEM : err.message)
  }

  /** Drops the error of each field the shopper has just changed. */
  function changeForm(next: QuoteRequest) {
    setFieldErrors((prev) => {
      const kept: FieldErrors = {}
      for (const [f, msg] of Object.entries(prev) as [AddressField, string][]) {
        if (fieldValue(next, f) === fieldValue(form, f)) kept[f] = msg
      }
      return kept
    })
    setForm(next)
  }

  async function quote(): Promise<Quote | null> {
    try {
      return await quoteCheckout(id, { ...form, address: { ...form.address, country: 'US' } })
    } catch (err) {
      await show(err)
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
    // retryToken is NOT cleared here: an earlier unknown outcome stays
    // unknown until an outcome below settles the attempt.
    try {
      const result = await payCheckout(id, { sourceToken: token, quoteVersion: step.quote.quoteVersion })
      setRetryToken(null)
      if (result.status === 'paid') completePaid(id)
      else complete()
    } catch (err) {
      if (err instanceof CheckoutError && SETTLES_ATTEMPT.has(err.code)) setRetryToken(null)
      if (err instanceof CheckoutError && err.code === 'quote_changed') {
        // Core refused before charging; replace amount and version together.
        const q = await quote()
        if (q) {
          setStep({ kind: 'pay', quote: q })
          setNotice(`Your total changed to ${formatCents(q.totalCents)} — check it and pay again.`)
        }
      } else if (err instanceof CheckoutError && err.code === 'checkout_unavailable') {
        // A DEFINITE failure (outcome 'failed'): no payment was created, so
        // this token can never succeed -- settle the attempt instead of
        // offering a Try again that would just fail again. An unknown
        // outcome (outcome null) keeps the retry lock as before.
        setRetryToken(err.outcome === 'failed' ? null : token)
        setError(UNAVAILABLE_MESSAGE)
      } else {
        await show(err)
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
      <PageHeader eyebrow="Checkout" title={step.kind === 'address' ? 'Shipping' : 'Payment'} intro={CONTIGUOUS_NOTICE}
        headingRef={heading} />
      {step.kind === 'address' ? (
        <div className="space-y-4">
          <AddressForm value={form} onChange={changeForm} onSubmit={() => { void submitAddress() }} busy={busy} errors={fieldErrors}
            focusRequest={focusRequest} />
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

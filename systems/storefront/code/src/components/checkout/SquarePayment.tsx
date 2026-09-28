import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ApplePay, Card, GooglePay, PaymentRequest, TokenResult } from '@square/web-payments-sdk-types'
import { loadSquare, type SquareConfig } from '../../lib/square'
import { UNAVAILABLE_MESSAGE, type QuoteRequest } from '../../lib/api/checkout'
import { centsToDecimal, formatCents } from '../../lib/money'
import { Button } from '../../design-system/primitives'

export const STORE_LABEL = 'Alpine Brick Exchange'
export const CARD_PROBLEM = 'Check your card details and try again.'

/** Apple's own button rendering (WebKit only; elsewhere the button never shows). */
const APPLE_PAY_STYLE = { WebkitAppearance: '-apple-pay-button', height: 48, width: '100%' } as CSSProperties

interface Props {
  config: SquareConfig
  amountCents: number
  /** The quoted address and email, sent as the billing contact for buyer verification. */
  contact: QuoteRequest
  disabled: boolean
  /**
   * Called with the payment token. Return the page's pay call as a promise
   * to keep every pay control locked until it settles; the page reports that
   * call's own errors.
   */
  onToken: (token: string) => void | Promise<unknown>
  /**
   * true from the click that starts a payment until tokenizing (and the
   * promise onToken returned) settles; the page locks Edit address meanwhile.
   */
  onPayingChange?: (paying: boolean) => void
}

/**
 * Square's card form and the Apple Pay / Google Pay buttons (spec §2 step 4,
 * Q6). Card data never touches our page: Square's hosted fields tokenize it,
 * and buyer verification (3DS) runs inside tokenize().
 */
export default function SquarePayment({ config, amountCents, contact, disabled, onToken, onPayingChange }: Props) {
  const cardEl = useRef<HTMLDivElement>(null)
  const googleEl = useRef<HTMLDivElement>(null)
  const card = useRef<Card | null>(null)
  const request = useRef<PaymentRequest | null>(null)
  const amount = useRef(amountCents)
  amount.current = amountCents
  // The ref, not the state, is the guard: it flips inside the click, so a
  // second click that lands before React re-renders is still refused.
  const paying = useRef(false)
  const [busy, setBusy] = useState(false)
  const [applePay, setApplePay] = useState<ApplePay | null>(null)
  const [googlePay, setGooglePay] = useState<GooglePay | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [problem, setProblem] = useState<string | null>(null)
  const { applicationId, locationId } = config

  useEffect(() => {
    let live = true
    const made: { destroy(): Promise<boolean> }[] = []
    /** Tracks an instance for cleanup; one made after cleanup is destroyed at once. */
    function keep(m: { destroy(): Promise<boolean> }): boolean {
      if (live) {
        made.push(m)
        return true
      }
      void m.destroy().catch(() => false)
      return false
    }
    void (async () => {
      const square = await loadSquare()
      if (!live) return
      if (!square) {
        setState('failed')
        return
      }
      try {
        const payments = square.payments(applicationId, locationId)
        const c = await payments.card()
        if (!keep(c) || !cardEl.current) return
        await c.attach(cardEl.current)
        if (!live) return
        card.current = c
        const req = payments.paymentRequest({
          countryCode: 'US', currencyCode: 'USD', total: { amount: centsToDecimal(amount.current), label: STORE_LABEL },
        })
        request.current = req
        setState('ready')
        try {
          const ap = await payments.applePay(req)
          if (!keep(ap)) return
          setApplePay(ap)
        } catch { /* Apple Pay is not available on this device or domain */ }
        if (!live) return
        try {
          const gp = await payments.googlePay(req)
          if (!keep(gp) || !googleEl.current) return
          await gp.attach(googleEl.current)
          if (live) setGooglePay(gp)
        } catch { /* Google Pay is not available here */ }
      } catch (err) {
        console.error('Payment form failed to initialise', err)
        if (live) setState('failed')
      }
    })()
    return () => {
      live = false
      card.current = null
      request.current = null
      for (const m of made) void m.destroy().catch(() => false)
    }
  }, [applicationId, locationId])

  // A re-quote changes the total; the wallet sheets must show the new one.
  useEffect(() => {
    request.current?.update({ total: { amount: centsToDecimal(amountCents), label: STORE_LABEL } })
  }, [amountCents])

  /** Claims the single payment slot; false when disabled or one is in flight. */
  function claim(): boolean {
    if (disabled || paying.current) return false
    paying.current = true
    return true
  }

  function started() {
    setProblem(null)
    setBusy(true)
    onPayingChange?.(true)
  }

  function release() {
    paying.current = false
    setBusy(false)
    onPayingChange?.(false)
  }

  async function settle(result: TokenResult) {
    try {
      if (result.status === 'OK') await onToken(result.token)
      else if (result.status !== 'Cancel' && result.status !== 'Abort') setProblem(CARD_PROBLEM)
    } catch {
      /* the page shows its own pay-call errors */
    } finally {
      release()
    }
  }

  async function payByCard() {
    if (!card.current || !claim()) return
    started()
    let result: TokenResult
    try {
      result = await card.current.tokenize({
        amount: centsToDecimal(amountCents),
        currencyCode: 'USD',
        intent: 'CHARGE',
        billingContact: {
          givenName: contact.name,
          email: contact.email,
          addressLines: [contact.address.line1, ...(contact.address.line2 ? [contact.address.line2] : [])],
          city: contact.address.city,
          state: contact.address.state,
          postalCode: contact.address.postalCode,
          countryCode: 'US',
        },
        customerInitiated: true,
        sellerKeyedIn: false,
      })
    } catch {
      setProblem(CARD_PROBLEM)
      release()
      return
    }
    await settle(result)
  }

  function payByWallet(method: ApplePay | GooglePay) {
    if (!claim()) return
    // Apple requires tokenize() to start inside the click handler, before any await.
    let pending: Promise<TokenResult>
    try {
      pending = method.tokenize()
    } catch {
      // A synchronous throw must not keep the slot claimed forever.
      paying.current = false
      setProblem(CARD_PROBLEM)
      return
    }
    started()
    pending.then(settle, () => {
      setProblem(CARD_PROBLEM)
      release()
    })
  }

  if (state === 'failed') {
    return (
      <div role="alert" className="space-y-2">
        <p className="font-semibold">We couldn't load the payment form</p>
        <p className="text-sm text-muted-foreground">{UNAVAILABLE_MESSAGE}</p>
      </div>
    )
  }

  const locked = disabled || busy
  return (
    <div className="space-y-4">
      {applePay && (
        <button type="button" aria-label="Pay with Apple Pay" style={APPLE_PAY_STYLE} disabled={locked}
          onClick={() => payByWallet(applePay)} />
      )}
      {/* Square renders its own labelled Google Pay button inside this container. */}
      <div ref={googleEl} data-testid="google-pay-container" hidden={!googlePay}
        onClick={() => { if (googlePay) payByWallet(googlePay) }} />
      <div ref={cardEl} data-testid="card-container" />
      {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">Loading the payment form…</p>}
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <Button className="w-full" onClick={payByCard} disabled={locked || state !== 'ready'}>
        {`Pay ${formatCents(amountCents)}`}
      </Button>
    </div>
  )
}

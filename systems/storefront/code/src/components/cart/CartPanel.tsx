import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Minus, Plus, X } from 'lucide-react'
import { useCart, MAX_QUANTITY } from '../../lib/cart/CartContext'
import { formatCents } from '../../lib/money'
import { imageUrl } from '../../lib/images'
import {
  startCheckout, getCheckoutConfig, CheckoutError, UNAVAILABLE_MESSAGE, type LineProblem,
} from '../../lib/api/checkout'
import { readReferral, safeLocalStorage } from '../../lib/referral'
import { getPreviousOrderId, setPreviousOrderId } from '../../lib/checkout/previousOrder'
import { squareConfig } from '../../lib/square'
import { Button } from '../../design-system/primitives'

export const CONTIGUOUS_NOTICE = 'We ship to the contiguous US only.'
export const OPT_IN_LABEL = 'Email me about new sets and restocks'

/** "$150" for whole dollars, "$149.50" otherwise -- the spec's copy says "$150". */
function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatCents(cents)
}

function problemText(p: LineProblem): string {
  if (p.code === 'variant_not_found') return 'No longer available'
  return p.available && p.available > 0 ? `Only ${p.available} left` : 'Out of stock'
}

/** Shared by the drawer and /cart (spec §6). */
export default function CartPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { items, subtotalCents, setQuantity, removeItem } = useCart()
  const navigate = useNavigate()
  const [optIn, setOptIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, LineProblem>>({})
  const [threshold, setThreshold] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    getCheckoutConfig()
      .then((c) => { if (live) setThreshold(c.freeShippingThresholdCents) })
      .catch(() => { /* no note rather than a wrong one */ })
    return () => { live = false }
  }, [])

  function forget(variantId: string) {
    setProblems((p) => {
      const next = { ...p }
      delete next[variantId]
      return next
    })
  }

  async function checkout() {
    if (busy) return
    setError(null)
    setProblems({})
    // A build without the VITE_SQUARE_* settings cannot show the payment
    // form, so starting a checkout would only reserve stock for nothing.
    if (squareConfig() === null) {
      setError(UNAVAILABLE_MESSAGE)
      return
    }
    setBusy(true)
    try {
      const previousOrderId = getPreviousOrderId()
      const { orderId } = await startCheckout({
        lines: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        marketingOptIn: optIn,
        referral: readReferral(safeLocalStorage()),
        ...(previousOrderId ? { previousOrderId } : {}),
      })
      setPreviousOrderId(orderId)
      onNavigate?.()
      navigate('/checkout', { state: { orderId } })
    } catch (err) {
      if (err instanceof CheckoutError && err.lines.length > 0) {
        setProblems(Object.fromEntries(err.lines.map((l) => [l.variantId, l])))
        setError('Some items in your cart need attention.')
      } else {
        setError(err instanceof CheckoutError ? err.message : UNAVAILABLE_MESSAGE)
      }
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>Your cart is empty.</p>
        <Link to="/collections" onClick={onNavigate} className="mt-4 inline-block underline">Browse the collections</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ul aria-label="Cart items" className="divide-y divide-border">
        {items.map((i) => {
          const problem = problems[i.variantId]
          return (
            <li key={i.variantId} className="py-4 flex gap-4">
              {i.imageKey && (
                <img src={imageUrl(i.imageKey, { width: 160 })} alt="" width={64} height={64} className="w-16 h-16 object-cover rounded-md" />
              )}
              <div className="flex-1 min-w-0">
                <Link to={`/product/${i.productSlug}`} onClick={onNavigate} className="font-semibold text-sm">{i.name}</Link>
                <p className="text-xs text-muted-foreground">{formatCents(i.priceCents)}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" aria-label={`Decrease quantity of ${i.name}`}
                    onClick={() => { setQuantity(i.variantId, i.quantity - 1); forget(i.variantId) }}
                    className="p-1.5 border border-border rounded-md"><Minus size={14} aria-hidden /></button>
                  <span aria-label={`Quantity of ${i.name}`} className="w-6 text-center text-sm">{i.quantity}</span>
                  <button type="button" aria-label={`Increase quantity of ${i.name}`} disabled={i.quantity >= MAX_QUANTITY}
                    onClick={() => { setQuantity(i.variantId, i.quantity + 1); forget(i.variantId) }}
                    className="p-1.5 border border-border rounded-md disabled:opacity-40"><Plus size={14} aria-hidden /></button>
                  <button type="button" aria-label={`Remove ${i.name}`} onClick={() => { removeItem(i.variantId); forget(i.variantId) }}
                    className="ml-auto p-1.5 text-muted-foreground hover:text-foreground"><X size={14} aria-hidden /></button>
                </div>
                {problem && <p role="alert" className="mt-1 text-xs text-destructive">{problemText(problem)}</p>}
              </div>
            </li>
          )
        })}
      </ul>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatCents(subtotalCents)}</span></div>
        <p className="text-muted-foreground">Shipping and tax calculated at checkout</p>
        {threshold !== null && subtotalCents < threshold && (
          <p className="text-muted-foreground">{`Free shipping on orders over ${dollars(threshold)}`}</p>
        )}
        <p className="text-muted-foreground">{CONTIGUOUS_NOTICE}</p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
        {OPT_IN_LABEL}
      </label>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" onClick={checkout} disabled={busy}>{busy ? 'Starting checkout…' : 'Checkout'}</Button>
    </div>
  )
}

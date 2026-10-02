import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface CartLine {
  variantId: string
  productId: string
  productSlug: string
  name: string
  priceCents: number
  /** Storage key of the product's primary image, NOT a URL. Resolve at render. */
  imageKey: string
  quantity: number
}

interface CartValue {
  items: CartLine[]
  count: number
  subtotalCents: number
  /** false when the cart already holds MAX_LINES other variants; nothing is added. */
  addItem: (line: Omit<CartLine, 'quantity'>, qty?: number) => boolean
  setQuantity: (variantId: string, qty: number) => void
  removeItem: (variantId: string) => void
  clear: () => void
}

/** Spec §4: core accepts 1–10 per line. */
export const MAX_QUANTITY = 10
/** Spec §4: core accepts at most 20 lines per checkout. */
export const MAX_LINES = 20
export const LINE_LIMIT_MESSAGE = `Your cart can hold up to ${MAX_LINES} different items.`
export const CART_STORAGE_KEY = 'ab.cart.v1'

const CartContext = createContext<CartValue | null>(null)

const cap = (q: number) => Math.min(MAX_QUANTITY, q)

function isCartLine(x: unknown): x is CartLine {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null
    && typeof l.variantId === 'string' && typeof l.productId === 'string' && typeof l.productSlug === 'string'
    && typeof l.name === 'string' && typeof l.imageKey === 'string'
    && Number.isInteger(l.priceCents) && Number.isInteger(l.quantity) && (l.quantity as number) > 0
}

function loadCart(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(isCartLine).slice(0, MAX_LINES).map((l) => ({ ...l, quantity: cap(l.quantity) }))
      : []
  } catch {
    return []
  }
}

/**
 * Line identity is the VARIANT, not the product.
 *
 * The design handoff's reference implementation keyed on product id, which
 * would collapse two variants of one product into a single line at whichever
 * price was added first — and core's checkout takes variantId, so such a line
 * could not be ordered at all.
 *
 * Persisted to localStorage: Stripe's return_url is a full page load, so an
 * in-memory cart would already be gone when the confirmation page clears it.
 * Prices here are display-only; core snapshots live prices at checkout.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartLine[]>(loadCart)
  // Mirrors the latest items synchronously so addItem can report whether the
  // line fit, even for several calls inside one batch.
  const latest = useRef(items)

  useEffect(() => {
    try { window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items)) } catch { /* blocked or full */ }
  }, [items])

  const commit = useCallback((next: CartLine[]) => {
    latest.current = next
    setItems(next)
  }, [])

  const addItem = useCallback((line: Omit<CartLine, 'quantity'>, qty = 1) => {
    const prev = latest.current
    const found = prev.some((i) => i.variantId === line.variantId)
    if (!found && prev.length >= MAX_LINES) return false
    const next = found
      ? prev.map((i) => (i.variantId === line.variantId ? { ...i, quantity: cap(i.quantity + qty) } : i))
      : [...prev, { ...line, quantity: cap(qty) }]
    commit(next)
    return true
  }, [commit])

  const setQuantity = useCallback((variantId: string, qty: number) => {
    const prev = latest.current
    commit(
      qty <= 0
        ? prev.filter((i) => i.variantId !== variantId)
        : prev.map((i) => (i.variantId === variantId ? { ...i, quantity: cap(qty) } : i)),
    )
  }, [commit])

  const removeItem = useCallback((variantId: string) => {
    commit(latest.current.filter((i) => i.variantId !== variantId))
  }, [commit])

  const clear = useCallback(() => commit([]), [commit])

  const value = useMemo<CartValue>(
    () => ({
      items,
      count: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: items.reduce((n, i) => n + i.priceCents * i.quantity, 0),
      addItem, setQuantity, removeItem, clear,
    }),
    [items, addItem, setQuantity, removeItem, clear],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside a CartProvider')
  return ctx
}

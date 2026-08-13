import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

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
  addItem: (line: Omit<CartLine, 'quantity'>, qty?: number) => void
  setQuantity: (variantId: string, qty: number) => void
  removeItem: (variantId: string) => void
}

const CartContext = createContext<CartValue | null>(null)

/**
 * Line identity is the VARIANT, not the product.
 *
 * The design handoff's reference implementation keyed on product id, which
 * would collapse two variants of one product into a single line at whichever
 * price was added first — and core's order API takes variantId, so such a line
 * could not be ordered at all.
 *
 * In-memory only: this is lost on reload. Persistence is a later sub-project.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([])

  function addItem(line: Omit<CartLine, 'quantity'>, qty = 1) {
    setItems(prev => {
      const found = prev.find(i => i.variantId === line.variantId)
      if (found) {
        return prev.map(i =>
          i.variantId === line.variantId ? { ...i, quantity: i.quantity + qty } : i,
        )
      }
      return [...prev, { ...line, quantity: qty }]
    })
  }

  function setQuantity(variantId: string, qty: number) {
    setItems(prev =>
      qty <= 0
        ? prev.filter(i => i.variantId !== variantId)
        : prev.map(i => (i.variantId === variantId ? { ...i, quantity: qty } : i)),
    )
  }

  function removeItem(variantId: string) {
    setItems(prev => prev.filter(i => i.variantId !== variantId))
  }

  const value = useMemo<CartValue>(
    () => ({
      items,
      count: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: items.reduce((n, i) => n + i.priceCents * i.quantity, 0),
      addItem,
      setQuantity,
      removeItem,
    }),
    [items],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside a CartProvider')
  return ctx
}

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { CartProvider, useCart } from './CartContext'

const wrapper = ({ children }: { children: ReactNode }) => <CartProvider>{children}</CartProvider>

const LINE_A = {
  variantId: 'v1', productId: 'p1', productSlug: 'a',
  name: 'Set A', priceCents: 5000, image: '/a.jpg',
}
// Same product, different variant and price.
const LINE_B = {
  variantId: 'v2', productId: 'p1', productSlug: 'a',
  name: 'Set A', priceCents: 7000, image: '/a.jpg',
}

describe('cart', () => {
  it('adds a line and counts it', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A))
    expect(result.current.count).toBe(1)
    expect(result.current.subtotalCents).toBe(5000)
  })

  // The reference implementation keyed on product id, which would collapse
  // these two into one line at the wrong price — and core's order API takes
  // variantId, so the collapsed line could not be ordered at all.
  it('keeps two variants of the same product as separate lines', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_B) })
    expect(result.current.items).toHaveLength(2)
    expect(result.current.subtotalCents).toBe(12000)
  })

  it('increments quantity when the same variant is added twice', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_A) })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.count).toBe(2)
    expect(result.current.subtotalCents).toBe(10000)
  })

  it('adds a requested quantity in one call', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A, 3))
    expect(result.current.count).toBe(3)
    expect(result.current.subtotalCents).toBe(15000)
  })

  it('removes a line when quantity is set to zero', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A))
    act(() => result.current.setQuantity('v1', 0))
    expect(result.current.items).toHaveLength(0)
  })

  it('removes a line explicitly', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_B) })
    act(() => result.current.removeItem('v1'))
    expect(result.current.items.map(i => i.variantId)).toEqual(['v2'])
  })

  it('subtotal stays in integer cents with no float drift', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    // 3 x 1999c = 5997c. A float dollars implementation lands on 59.97000000000001.
    act(() => result.current.addItem({ ...LINE_A, variantId: 'v9', priceCents: 1999 }, 3))
    expect(result.current.subtotalCents).toBe(5997)
    expect(Number.isInteger(result.current.subtotalCents)).toBe(true)
  })
})

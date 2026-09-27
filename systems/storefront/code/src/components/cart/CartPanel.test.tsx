import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../../lib/cart/CartContext'

vi.mock('../../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/checkout')>()
  return { ...actual, startCheckout: vi.fn(), getCheckoutConfig: vi.fn() }
})
import { startCheckout, getCheckoutConfig, CheckoutError } from '../../lib/api/checkout'
import CartPanel from './CartPanel'

afterEach(() => vi.clearAllMocks())

const LINE = (variantId: string, name: string, priceCents: number, quantity: number) => ({
  variantId, productId: `p-${variantId}`, productSlug: name.toLowerCase().replace(/ /g, '-'), name, priceCents, imageKey: '', quantity,
})

function StateProbe() {
  const state = useLocation().state as { clientSecret: string; orderId: string }
  return <p>checkout page {state.clientSecret} {state.orderId}</p>
}

/**
 * Declarative MemoryRouter, not createMemoryRouter/RouterProvider: the data
 * router builds a real Request (with a jsdom AbortSignal) for every
 * navigate() call, which Node's native fetch/Request rejects as "Expected
 * signal to be an instance of AbortSignal" -- a pre-existing jsdom/Node realm
 * mismatch already documented in referral.test.tsx and catalog-pages.test.tsx
 * (see Task 11's report). The declarative router exercises the same
 * useNavigate()/location-state behavior without going through that machinery.
 */
function renderCart(lines: ReturnType<typeof LINE>[], threshold: number | null = 15000) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines))
  vi.mocked(getCheckoutConfig).mockResolvedValue({ flatRateCents: 995, freeShippingThresholdCents: threshold })
  return render(
    <MemoryRouter initialEntries={['/cart']}>
      <Routes>
        <Route path="/cart" element={<CartProvider><CartPanel /></CartProvider>} />
        <Route path="/checkout" element={<StateProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CartPanel', () => {
  it('shows the subtotal and the checkout notes', async () => {
    renderCart([LINE('v1', 'Dragon Fortress', 4999, 2)])
    expect(screen.getByText('$99.98')).toBeInTheDocument()
    expect(screen.getByText('Shipping and tax calculated at checkout')).toBeInTheDocument()
    expect(screen.getByText('We ship to the contiguous US only.')).toBeInTheDocument()
    expect(await screen.findByText('Free shipping on orders over $150')).toBeInTheDocument()
  })

  it('drops the free-shipping note at or over the threshold', async () => {
    renderCart([LINE('v1', 'Skyline', 18900, 1)])
    // Ruling P2: let the mocked config promise resolve (and the component
    // re-render off it) before asserting the note is absent -- otherwise this
    // assertion runs before the fetch settles and can never fail.
    await vi.waitFor(() => expect(getCheckoutConfig).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('Shipping and tax calculated at checkout')).toBeInTheDocument()
    expect(screen.queryByText(/Free shipping on orders over/)).not.toBeInTheDocument()
  })

  it('has the opt-in unticked, caps quantity at 10 and removes lines', async () => {
    renderCart([LINE('v1', 'Dragon Fortress', 100, 9)])
    expect(screen.getByRole('checkbox', { name: 'Email me about new sets and restocks' })).not.toBeChecked()
    const inc = screen.getByRole('button', { name: 'Increase quantity of Dragon Fortress' })
    await userEvent.click(inc)
    expect(screen.getByLabelText('Quantity of Dragon Fortress')).toHaveTextContent('10')
    expect(inc).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Dragon Fortress' }))
    expect(screen.getByText(/Your cart is empty/)).toBeInTheDocument()
  })

  it('starts checkout with lines, opt-in, referral and the previous order, then opens /checkout', async () => {
    window.localStorage.setItem('ab.referral', JSON.stringify({ code: 'club', firstSeenAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }))
    window.sessionStorage.setItem('ab.previousOrderId', 'old-order')
    vi.mocked(startCheckout).mockResolvedValue({ orderId: 'new-order', clientSecret: 'cs_secret_1' })
    renderCart([LINE('v1', 'Dragon Fortress', 4999, 2)])
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email me about new sets and restocks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(startCheckout).toHaveBeenCalledWith({
      lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: true,
      referral: { code: 'club', firstSeenAt: '2026-10-01T00:00:00.000Z' }, previousOrderId: 'old-order',
    })
    expect(await screen.findByText('checkout page cs_secret_1 new-order')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('new-order')
  })

  it('marks short and missing lines and keeps the rest', async () => {
    vi.mocked(startCheckout).mockRejectedValue(new CheckoutError('insufficient_stock', 'x', [
      { variantId: 'v1', code: 'insufficient_stock', available: 2 },
      { variantId: 'v2', code: 'variant_not_found' },
    ]))
    renderCart([LINE('v1', 'Dragon Fortress', 100, 3), LINE('v2', 'Old Set', 100, 1), LINE('v3', 'Skyline', 100, 1)])
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    const items = within(screen.getByRole('list', { name: 'Cart items' })).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Only 2 left')).toBeInTheDocument()
    expect(within(items[1]).getByText('No longer available')).toBeInTheDocument()
    expect(within(items[2]).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the spec message when checkout is unavailable', async () => {
    vi.mocked(startCheckout).mockRejectedValue(new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.'))
    renderCart([LINE('v1', 'Dragon Fortress', 100, 1)])
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(await screen.findByText('Checkout is temporarily unavailable — please try again in a minute.')).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

const captured = vi.hoisted(() => ({ options: undefined as undefined | { fetchClientSecret: () => Promise<string> } }))
vi.mock('@stripe/react-stripe-js', () => ({
  EmbeddedCheckoutProvider: ({ options, children }: { options: typeof captured.options; children: ReactNode }) => {
    captured.options = options
    return <div data-testid="provider">{children}</div>
  },
  EmbeddedCheckout: () => <div data-testid="embedded-checkout" />,
}))
vi.mock('../lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, getCheckoutStatus: vi.fn() }
})
import { getStripe } from '../lib/stripe'
import { getCheckoutStatus, type CheckoutStatus } from '../lib/api/checkout'
import Checkout from './Checkout'
import OrderComplete, { POLL_LIMIT_MS } from './OrderComplete'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

function renderCheckout(state?: { clientSecret: string; orderId: string }) {
  const router = createMemoryRouter(
    [{ path: '/checkout', element: <Checkout /> }, { path: '/cart', element: <p>cart page</p> }],
    { initialEntries: [{ pathname: '/checkout', state }] },
  )
  return render(<RouterProvider router={router} />)
}

describe('/checkout', () => {
  it('mounts Embedded Checkout with the client secret and remembers the order', async () => {
    vi.mocked(getStripe).mockReturnValue(Promise.resolve({} as never))
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'order-1' })
    expect(screen.getByTestId('embedded-checkout')).toBeInTheDocument()
    expect(await captured.options!.fetchClientSecret()).toBe('cs_1_secret')
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
    expect(screen.getByText('We ship to the contiguous US only.')).toBeInTheDocument()
    for (const name of ['Terms', 'Privacy', 'Refund', 'Shipping']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('sends a visitor without a session back to the cart', () => {
    vi.mocked(getStripe).mockReturnValue(Promise.resolve({} as never))
    renderCheckout()
    expect(screen.getByText('Your checkout has ended')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('explains when there is no publishable key', () => {
    vi.mocked(getStripe).mockReturnValue(null)
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'o' })
    expect(screen.getByText("We couldn't load the payment form")).toBeInTheDocument()
    expect(screen.queryByTestId('embedded-checkout')).not.toBeInTheDocument()
  })

  it('explains when Stripe.js fails to load', async () => {
    vi.mocked(getStripe).mockReturnValue(Promise.reject(new Error('blocked by an extension')))
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'o' })
    expect(await screen.findByText("We couldn't load the payment form")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toBeInTheDocument()
  })
})

const PAID: CheckoutStatus = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 1, unitPriceCents: 24900, lineSubtotalCents: 24900 }],
  totals: { subtotalCents: 24900, shippingCents: 0, taxCents: 1494, totalCents: 26394 },
}

function renderComplete(search = '?session_id=cs_test_1') {
  const router = createMemoryRouter(
    [{ path: '/order/complete', element: <CartProvider><OrderComplete /></CartProvider> }],
    { initialEntries: [`/order/complete${search}`] },
  )
  return render(<RouterProvider router={router} />)
}

const CART_LINE = [{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]

function seedCartAndPreviousOrder() {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(CART_LINE))
  window.sessionStorage.setItem('ab.previousOrderId', 'order-1')
}

function expectCartKept() {
  expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual(CART_LINE)
  expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
}

function expectCartCleared() {
  expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
  expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
}

describe('/order/complete', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('confirms a paid order, then clears the cart and the previous order', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]))
    window.sessionStorage.setItem('ab.previousOrderId', 'order-1')
    vi.mocked(getCheckoutStatus).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
    expect(screen.getByText('Your receipt is on its way from Stripe')).toBeInTheDocument()
    expect(screen.getByText('$263.94')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
  })

  // Jack, 2026-09-27: Stripe only redirects here after payment, so the slow
  // state clears the cart too -- a cart left full invites a second purchase.
  it('polls every 1.5 s, settles on the slow message at 20 s and clears the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'pending' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(3) // t=0, 1.5, 3.0
    expectCartKept() // still polling: nothing cleared yet
    await act(() => vi.advanceTimersByTimeAsync(POLL_LIMIT_MS))
    expect(screen.getByText("Payment received — we're confirming your order. Your Stripe receipt is your confirmation.")).toBeInTheDocument()
    expectCartCleared()
    const calls = vi.mocked(getCheckoutStatus).mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(calls) // stopped
  })

  it('keeps polling through a transient error', async () => {
    vi.mocked(getCheckoutStatus).mockRejectedValueOnce(new Error('blip')).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
  })

  it('says the checkout expired and keeps the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'cancelled' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('This checkout expired')).toBeInTheDocument()
    expectCartKept()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('handles a missing session id without calling core', async () => {
    renderComplete('')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).not.toHaveBeenCalled()
    expect(screen.getByText("We couldn't find that checkout")).toBeInTheDocument()
  })

  it('shows a terminal state when core reports the order not_found (Ruling P10)', async () => {
    const { CheckoutError } = await import('../lib/api/checkout')
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockRejectedValue(new CheckoutError('not_found', 'not found'))
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText("We couldn't find that order")).toBeInTheDocument()
    expectCartKept()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
    const calls = vi.mocked(getCheckoutStatus).mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(calls) // stopped, no retry-forever
  })
})

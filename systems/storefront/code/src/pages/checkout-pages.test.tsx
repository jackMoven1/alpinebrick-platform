import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, getCheckoutStatus: vi.fn() }
})
import { getCheckoutStatus, CheckoutError, type CheckoutStatus } from '../lib/api/checkout'
import OrderComplete, { POLL_LIMIT_MS, SLOW_MESSAGE } from './OrderComplete'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

const PAID: CheckoutStatus = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 1, unitPriceCents: 24900, lineSubtotalCents: 24900 }],
  totals: { subtotalCents: 24900, shippingCents: 0, taxCents: 1494, totalCents: 26394 },
}
const CART_LINE = [{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]

// No navigation happens on this page, so the data router is safe here.
function renderComplete(search = '?order=order-1') {
  const router = createMemoryRouter(
    [{ path: '/order/complete', element: <CartProvider><OrderComplete /></CartProvider> }],
    { initialEntries: [`/order/complete${search}`] },
  )
  return render(<RouterProvider router={router} />)
}
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

  it('confirms a paid order by id, with no provider name, then clears the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).toHaveBeenCalledWith('order-1')
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
    expect(screen.getByText('$263.94')).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain('stripe')
    expectCartCleared()
  })

  it('polls every 1.5 s, settles on the slow message at 20 s and clears the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'pending' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(3)
    expectCartKept()
    await act(() => vi.advanceTimersByTimeAsync(POLL_LIMIT_MS))
    expect(screen.getByText(SLOW_MESSAGE)).toBeInTheDocument()
    expectCartCleared()
    const calls = vi.mocked(getCheckoutStatus).mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(calls)
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
  })

  it('handles a missing order id without calling core', async () => {
    renderComplete('')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).not.toHaveBeenCalled()
    expect(screen.getByText("We couldn't find that checkout")).toBeInTheDocument()
  })

  it('shows a terminal state when core reports the order not_found (Ruling P10)', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockRejectedValue(new CheckoutError('not_found', 'not found'))
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText("We couldn't find that order")).toBeInTheDocument()
    expectCartKept()
  })
})

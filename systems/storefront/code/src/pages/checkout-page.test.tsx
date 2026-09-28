// src/pages/checkout-page.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation, useNavigationType } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

// What the page's onToken returned on the last click (controller ruling: it
// must be the pay call's promise, so SquarePayment's lock spans the charge).
const fake = vi.hoisted(() => ({ returned: undefined as unknown }))
vi.mock('../components/checkout/SquarePayment', () => ({
  default: ({ onToken, onPayingChange, amountCents, disabled }: {
    onToken: (t: string) => void | Promise<unknown>
    onPayingChange?: (paying: boolean) => void
    amountCents: number
    disabled: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={() => {
      onPayingChange?.(true)
      const r = onToken('tok_1')
      fake.returned = r
      void Promise.resolve(r).catch(() => undefined).finally(() => onPayingChange?.(false))
    }}>{`Fake pay ${amountCents}`}</button>
  ),
}))
vi.mock('../lib/square', () => ({ squareConfig: vi.fn(() => ({ applicationId: 'a', locationId: 'l', environment: 'sandbox' })) }))
vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, quoteCheckout: vi.fn(), payCheckout: vi.fn(), getCheckoutStatus: vi.fn() }
})
import { squareConfig } from '../lib/square'
import {
  quoteCheckout, payCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE,
  type Quote, type PaidResult, type PayResult, type CheckoutStatus,
} from '../lib/api/checkout'
import Checkout from './Checkout'

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); fake.returned = undefined })

// user-event resolves its own @testing-library/dom, which RTL has not wired to
// act(), so each action (and the async state it sets off) is flushed in act here.
const user = {
  type: (el: Element, text: string) => act(async () => { await userEvent.type(el, text) }),
  click: (el: Element) => act(async () => { await userEvent.click(el) }),
  selectOptions: (el: Element, value: string) => act(async () => { await userEvent.selectOptions(el, value) }),
}

const QUOTE: Quote = { quoteVersion: 1, subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 }
const PAID: PaidResult = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 }],
  totals: { subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 },
}
const CART = [{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]
const CANCELLED_STATUS: CheckoutStatus = { ...PAID, status: 'cancelled' }
const PENDING_STATUS: CheckoutStatus = { ...PAID, status: 'pending' }

// The page checks the order's status once on mount (Ruling S-F1); by default
// the order is still pending, so the address form shows.
beforeEach(() => { vi.mocked(getCheckoutStatus).mockResolvedValue(PENDING_STATUS) })

function Probe() {
  const { pathname, search } = useLocation()
  return <><p>{`at ${pathname}${search}`}</p><p>{`navigation ${useNavigationType()}`}</p></>
}

/** A paid order leaves /checkout for /order/complete, replacing the history entry. */
async function expectCompleted() {
  expect(await screen.findByText('at /order/complete?order=order-1')).toBeInTheDocument()
  expect(screen.getByText('navigation REPLACE')).toBeInTheDocument()
  expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
  expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
}

function renderCheckout(state: { orderId: string } | null = { orderId: 'order-1' }) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(CART))
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/checkout', state }]}>
      <CartProvider>
        <Routes>
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/order/complete" element={<Probe />} />
          <Route path="/cart" element={<p>cart page</p>} />
        </Routes>
      </CartProvider>
    </MemoryRouter>,
  )
}

async function fillAddress(state = 'MI') {
  await user.type(await screen.findByLabelText('Email'), 'ann@example.com')
  await user.type(screen.getByLabelText('Full name'), 'Ann Buyer')
  await user.type(screen.getByLabelText('Address line 1'), '1 Main St')
  await user.type(screen.getByLabelText('City'), 'Traverse City')
  await user.selectOptions(screen.getByLabelText('State'), state)
  await user.type(screen.getByLabelText('ZIP code'), '49684')
  await user.click(screen.getByRole('button', { name: 'Continue to payment' }))
}

async function toPayStep() {
  vi.mocked(quoteCheckout).mockResolvedValue(QUOTE)
  renderCheckout()
  await fillAddress()
  return screen.findByRole('button', { name: 'Fake pay 11593' })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('/checkout', () => {
  it('sends a visitor without an order back to the cart', () => {
    renderCheckout(null)
    expect(screen.getByText('Your checkout has ended')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('explains when this build has no Square settings', () => {
    vi.mocked(squareConfig).mockReturnValueOnce(null)
    renderCheckout()
    expect(screen.getByText("We couldn't load the payment form")).toBeInTheDocument()
    expect(quoteCheckout).not.toHaveBeenCalled()
    expect(payCheckout).not.toHaveBeenCalled()
  })

  it('collects the address first, then shows the quoted total with tax on goods', async () => {
    renderCheckout()
    expect(await screen.findByText('We ship to the contiguous US only.')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
    await toPayStepFromHere()
    expect(quoteCheckout).toHaveBeenCalledWith('order-1', {
      email: 'ann@example.com', name: 'Ann Buyer',
      address: { line1: '1 Main St', line2: '', city: 'Traverse City', state: 'MI', postalCode: '49684', country: 'US' },
    })
    const summary = screen.getByRole('list', { name: 'Order total' })
    for (const text of ['$99.98', '$9.95', '$6.00', '$115.93']) expect(within(summary).getByText(text)).toBeInTheDocument()
    for (const name of ['Terms', 'Privacy', 'Refund', 'Shipping']) expect(screen.getByRole('link', { name })).toBeInTheDocument()
  })

  it('refuses Alaska at the address step with the spec copy, next to the state field', async () => {
    vi.mocked(quoteCheckout).mockRejectedValue(
      new CheckoutError('outside_shipping_area', 'We ship to the contiguous US only.', [], 'address.state'),
    )
    renderCheckout()
    await fillAddress('AK')
    expect(await screen.findByRole('alert')).toHaveTextContent('We ship to the contiguous US only.')
    expect(screen.getByLabelText('State')).toHaveAccessibleDescription('We ship to the contiguous US only.')
    expect(screen.queryByRole('button', { name: /Fake pay/ })).not.toBeInTheDocument()
  })

  it.each([
    ['address.postalCode', 'ZIP code', 'Enter a 5-digit ZIP code'],
    ['email', 'Email', 'Enter a valid email address'],
    ['address.state', 'State', 'Choose a state'],
  ])('shows friendly copy next to the field core refused (%s)', async (field, label, copy) => {
    vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError('invalid_request', `${field}: core wording`, [], field))
    renderCheckout()
    await fillAddress()
    expect(await screen.findByRole('alert')).toHaveTextContent(copy)
    expect(screen.getByLabelText(label)).toHaveAccessibleDescription(copy)
  })

  it.each([['body'], ['address'], ['orderId'], [null]])(
    'shows a generic message, never core wording, for a refusal naming no address field (%s)', async (field) => {
      vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError('invalid_request', 'body: must be an object', [], field))
      renderCheckout()
      await fillAddress()
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Something went wrong — start again from your cart.')
      expect(alert).not.toHaveTextContent('must be an object')
    })

  it("clears a field's error once that field changes, and only that field's", async () => {
    vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError('invalid_request', 'x', [], 'address.postalCode'))
    renderCheckout()
    await fillAddress()
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a 5-digit ZIP code')
    await user.type(screen.getByLabelText('City'), 'x')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a 5-digit ZIP code')
    await user.type(screen.getByLabelText('ZIP code'), '1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('ZIP code')).not.toHaveAccessibleDescription()
  })

  // Ruling S-F1 / I1: a confirmation rendered in place came back as a blank
  // address form on refresh; /order/complete survives a reload.
  it('on a paid result clears the cart and the previous order, then replaces /checkout with /order/complete', async () => {
    vi.mocked(payCheckout).mockResolvedValue(PAID)
    await user.click(await toPayStep())
    expect(payCheckout).toHaveBeenCalledWith('order-1', { sourceToken: 'tok_1', quoteVersion: 1 })
    await expectCompleted()
  })

  it('hands SquarePayment the pay call itself, so its lock lasts until the charge settles', async () => {
    const d = deferred<PayResult>()
    vi.mocked(payCheckout).mockReturnValue(d.promise)
    await user.click(await toPayStep())
    expect(fake.returned).toBeInstanceOf(Promise)
    let settled = false
    void (fake.returned as Promise<unknown>).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    d.resolve(PAID)
    await expectCompleted()
    expect(settled).toBe(true)
  })

  it('locks Edit address while a payment is in flight (Q-P1)', async () => {
    const d = deferred<PayResult>()
    vi.mocked(payCheckout).mockReturnValue(d.promise)
    await user.click(await toPayStep())
    expect(screen.getByRole('button', { name: 'Edit address' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Edit address' }))
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    d.resolve(PAID)
    await expectCompleted()
    expect(quoteCheckout).toHaveBeenCalledTimes(1)
  })

  it('Edit address returns to the form once no payment is in flight', async () => {
    vi.mocked(payCheckout).mockRejectedValueOnce(new CheckoutError('payment_declined', 'Your card was declined — try another card.'))
    await user.click(await toPayStep())
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Edit address' }))
    expect(screen.getByLabelText('Email')).toHaveValue('ann@example.com')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a decline under the card form, stays on the payment step, and a second card succeeds', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('payment_declined', 'Your card was declined — try another card.'))
      .mockResolvedValueOnce(PAID)
    const pay = await toPayStep()
    await user.click(pay)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your card was declined — try another card.')
    expect(pay.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fake pay 11593' }))
    await expectCompleted()
  })

  it('re-quotes on quote_changed, shows the new total, and pays the new quote version', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('quote_changed', 'Your total has changed. Check it and pay again.'))
      .mockResolvedValueOnce(PAID)
    const pay = await toPayStep()
    vi.mocked(quoteCheckout).mockResolvedValue({ ...QUOTE, quoteVersion: 2, totalCents: 12000 })
    await user.click(pay)
    expect(await screen.findByText('Your total changed to $120.00 — check it and pay again.')).toBeInTheDocument()
    expect(quoteCheckout).toHaveBeenCalledTimes(2)
    const summary = screen.getByRole('list', { name: 'Order total' })
    expect(within(summary).getByText('$120.00')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fake pay 12000' }))
    expect(vi.mocked(payCheckout).mock.calls[1][1]).toEqual({ sourceToken: 'tok_1', quoteVersion: 2 })
    await expectCompleted()
  })

  it('says the checkout expired, with a link back to the cart', async () => {
    vi.mocked(payCheckout).mockRejectedValue(new CheckoutError('order_expired', 'This checkout expired.'))
    vi.mocked(getCheckoutStatus).mockResolvedValueOnce(PENDING_STATUS).mockResolvedValue(CANCELLED_STATUS)
    await user.click(await toPayStep())
    expect(await screen.findByText('This checkout expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  // Controller ruling (carried from Task 11 review): the order can pay after
  // this page loaded (another tab). core then refuses the quote with
  // order_expired or not_found even though money changed hands -- check
  // status once rather than tell a paying customer their checkout expired.
  it.each([['order_expired'], ['not_found']] as const)(
    'an order that paid after the page loaded goes to the confirmation instead of expired (%s)', async (code) => {
      vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError(code, 'x'))
      vi.mocked(getCheckoutStatus).mockResolvedValueOnce(PENDING_STATUS).mockResolvedValue(PAID)
      renderCheckout()
      await fillAddress()
      await expectCompleted()
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2)
      expect(getCheckoutStatus).toHaveBeenLastCalledWith('order-1')
    })

  it('a quote refused for an order that is genuinely expired still shows the expired view', async () => {
    vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError('order_expired', 'x'))
    vi.mocked(getCheckoutStatus).mockResolvedValueOnce(PENDING_STATUS).mockResolvedValue(CANCELLED_STATUS)
    renderCheckout()
    await fillAddress()
    expect(await screen.findByText('This checkout expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it("too_many_attempts has its own title and keeps core's body", async () => {
    vi.mocked(payCheckout).mockRejectedValue(new CheckoutError('too_many_attempts', 'Too many payment attempts on this order. Start again from your cart.'))
    await user.click(await toPayStep())
    expect(await screen.findByText('Too many payment attempts')).toBeInTheDocument()
    expect(screen.getByText('Too many payment attempts on this order. Start again from your cart.')).toBeInTheDocument()
    expect(screen.queryByText('This checkout expired')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it.each([
    ['processing', () => vi.mocked(payCheckout).mockResolvedValue({ status: 'processing' })],
    ['payment_pending', () => vi.mocked(payCheckout).mockRejectedValue(new CheckoutError('payment_pending', 'x'))],
  ])('%s goes to the confirmation page to poll', async (_n, arrange) => {
    arrange()
    await user.click(await toPayStep())
    expect(await screen.findByText('at /order/complete?order=order-1')).toBeInTheDocument()
  })

  it('an unknown outcome offers Try again, which re-sends the SAME token (plan decision 3)', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE))
      .mockResolvedValueOnce(PAID)
    await user.click(await toPayStep())
    expect(await screen.findByRole('alert')).toHaveTextContent(UNAVAILABLE_MESSAGE)
    // Core may still be charging: no re-quote, and no second card, until it is known.
    expect(screen.getByRole('button', { name: 'Edit address' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fake pay 11593' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(vi.mocked(payCheckout).mock.calls.map((c) => c[1])).toEqual([
      { sourceToken: 'tok_1', quoteVersion: 1 }, { sourceToken: 'tok_1', quoteVersion: 1 },
    ])
    await expectCompleted()
  })

  it('a definite failure (outcome "failed") shows the unavailable message but offers no Try again, and the card form stays usable', async () => {
    vi.mocked(payCheckout).mockRejectedValueOnce(new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE, [], null, 'failed'))
    await user.click(await toPayStep())
    expect(await screen.findByRole('alert')).toHaveTextContent(UNAVAILABLE_MESSAGE)
    // No payment was created, so a retry with this token can never succeed --
    // unlike the unknown-outcome case, the attempt is treated as settled.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit address' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Fake pay 11593' })).toBeEnabled()
  })

  it('keeps the unknown-outcome lock when Try again is rate limited', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE))
      .mockRejectedValueOnce(new CheckoutError('rate_limited', 'Too many checkout attempts. Please wait a minute and try again.'))
    await user.click(await toPayStep())
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many checkout attempts. Please wait a minute and try again.')
    expect(screen.getByRole('button', { name: 'Edit address' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fake pay 11593' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(vi.mocked(payCheckout).mock.calls.map((c) => c[1].sourceToken)).toEqual(['tok_1', 'tok_1'])
  })

  it('a decline on Try again settles the attempt and unlocks a new card', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE))
      .mockRejectedValueOnce(new CheckoutError('payment_declined', 'Your card was declined — try another card.'))
    await user.click(await toPayStep())
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your card was declined — try another card.')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit address' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Fake pay 11593' })).toBeEnabled()
  })
})

// Ruling S-F1 / I1: history state carries the orderId through a refresh, so
// the page asks core once on mount where this order stands.
describe('/checkout on mount', () => {
  it('shows a loading status, not a blank form, while it asks', async () => {
    const d = deferred<CheckoutStatus>()
    vi.mocked(getCheckoutStatus).mockReturnValue(d.promise)
    renderCheckout()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your checkout…')
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    await act(async () => { d.resolve(PENDING_STATUS) })
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('a pending order gets the address form, after exactly one status call', async () => {
    renderCheckout()
    expect(await screen.findByLabelText('Email')).toHaveValue('')
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1)
    expect(getCheckoutStatus).toHaveBeenCalledWith('order-1')
  })

  it('a paid order (a refreshed confirmation) goes to /order/complete and forgets the cart', async () => {
    vi.mocked(getCheckoutStatus).mockResolvedValue(PAID)
    renderCheckout()
    await expectCompleted()
    expect(quoteCheckout).not.toHaveBeenCalled()
  })

  it('a cancelled order shows the expired view', async () => {
    vi.mocked(getCheckoutStatus).mockResolvedValue(CANCELLED_STATUS)
    renderCheckout()
    expect(await screen.findByText('This checkout expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual(CART)
  })

  it('an order core does not know shows the not-found view', async () => {
    vi.mocked(getCheckoutStatus).mockRejectedValue(new CheckoutError('not_found', 'Order not found.'))
    renderCheckout()
    expect(await screen.findByText("We couldn't find that order")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual(CART)
  })

  it.each([
    ['checkout_unavailable', () => new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE)],
    ['rate_limited', () => new CheckoutError('rate_limited', 'Too many checkout attempts. Please wait a minute and try again.')],
    ['an unexpected error', () => new Error('boom')],
  ])('a failed status check (%s) is logged, and the address form shows', async (_n, make) => {
    const err = make()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getCheckoutStatus).mockRejectedValue(err)
    renderCheckout()
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(log).toHaveBeenCalledWith(expect.any(String), err)
  })
})

describe('/checkout address form', () => {
  it.each([
    ['Full name', '100'], ['Address line 1', '100'], ['Address line 2 (optional)', '100'], ['City', '60'],
  ])("caps %s at core's limit", async (label, max) => {
    renderCheckout()
    expect(await screen.findByLabelText(label)).toHaveAttribute('maxlength', max)
  })

  it.each([
    ['invalid_request', 'address.postalCode', 'ZIP code'],
    ['outside_shipping_area', 'address.state', 'State'],
  ] as const)('moves focus to the field core refused (%s)', async (code, field, label) => {
    vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError(code, 'x', [], field))
    renderCheckout()
    await fillAddress()
    await screen.findByRole('alert')
    expect(screen.getByLabelText(label)).toHaveFocus()
  })

  it('moves focus to the payment heading when the payment step opens', async () => {
    await toPayStep()
    const heading = screen.getByRole('heading', { name: 'Payment' })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).toHaveFocus()
  })
})

async function toPayStepFromHere() {
  vi.mocked(quoteCheckout).mockResolvedValue(QUOTE)
  await fillAddress()
  await screen.findByRole('button', { name: 'Fake pay 11593' })
}

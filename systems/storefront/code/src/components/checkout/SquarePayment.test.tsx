import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/square', () => ({ loadSquare: vi.fn() }))
import { loadSquare } from '../../lib/square'
import SquarePayment, { CARD_PROBLEM, STORE_LABEL } from './SquarePayment'

const CONFIG = { applicationId: 'sandbox-sq0idb-test', locationId: 'LONLINE', environment: 'sandbox' as const }
const CONTACT = { email: 'ann@example.com', name: 'Ann Buyer', address: { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' } }

type TokenFn = () => Promise<unknown>
function fakeSquare(o: { tokenize?: unknown; applePay?: boolean; googlePay?: boolean; cardTokenize?: TokenFn; googleTokenize?: TokenFn } = {}) {
  const card = {
    attach: vi.fn(async () => {}),
    tokenize: vi.fn(o.cardTokenize ?? (async () => o.tokenize ?? { status: 'OK', token: 'tok_card' })),
    destroy: vi.fn(async () => true),
  }
  const request = { update: vi.fn(() => true), addEventListener: vi.fn() }
  const apple = { tokenize: vi.fn(async () => ({ status: 'OK', token: 'tok_apple' })), destroy: vi.fn(async () => true) }
  const google = { attach: vi.fn(async () => {}), tokenize: vi.fn(o.googleTokenize ?? (async () => ({ status: 'OK', token: 'tok_google' }))), destroy: vi.fn(async () => true) }
  const payments = {
    card: vi.fn(async () => card),
    paymentRequest: vi.fn(() => request),
    applePay: vi.fn(async () => { if (!o.applePay) throw new Error('unsupported'); return apple }),
    googlePay: vi.fn(async () => { if (!o.googlePay) throw new Error('unsupported'); return google }),
  }
  const square = { payments: vi.fn(() => payments) }
  vi.mocked(loadSquare).mockReturnValue(Promise.resolve(square as never))
  return { square, payments, card, request, apple, google }
}

type Over = Partial<{
  amountCents: number
  disabled: boolean
  onToken: (t: string) => void | Promise<void>
  onPayingChange: (paying: boolean) => void
}>
function renderPay(over: Over = {}) {
  const onToken = over.onToken ?? vi.fn()
  const view = render(
    <SquarePayment config={CONFIG} amountCents={over.amountCents ?? 11593} contact={CONTACT} disabled={over.disabled ?? false}
      onToken={onToken} onPayingChange={over.onPayingChange} />,
  )
  return { ...view, onToken }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => vi.clearAllMocks())

describe('SquarePayment', () => {
  it('attaches the card form at the configured location and tokenizes with verification details', async () => {
    const { square, card } = fakeSquare()
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    expect(square.payments).toHaveBeenCalledWith('sandbox-sq0idb-test', 'LONLINE')
    expect(card.attach).toHaveBeenCalledWith(screen.getByTestId('card-container'))
    await userEvent.click(pay)
    expect(card.tokenize).toHaveBeenCalledWith({
      amount: '115.93', currencyCode: 'USD', intent: 'CHARGE',
      billingContact: {
        givenName: 'Ann Buyer', email: 'ann@example.com', addressLines: ['1 Main St', 'Apt 2'],
        city: 'Traverse City', state: 'MI', postalCode: '49684', countryCode: 'US',
      },
      customerInitiated: true, sellerKeyedIn: false,
    })
    expect(onToken).toHaveBeenCalledWith('tok_card')
  })

  it('leaves out an empty second address line', async () => {
    const { card } = fakeSquare()
    render(<SquarePayment config={CONFIG} amountCents={11593} contact={{ ...CONTACT, address: { ...CONTACT.address, line2: '' } }}
      disabled={false} onToken={vi.fn()} />)
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    await userEvent.click(pay)
    expect(card.tokenize).toHaveBeenCalledWith(expect.objectContaining({
      billingContact: expect.objectContaining({ addressLines: ['1 Main St'] }),
    }))
  })

  it('asks the shopper to check the card when tokenize fails, without calling onToken', async () => {
    fakeSquare({ tokenize: { status: 'Invalid', errors: [] } })
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    await userEvent.click(pay)
    expect(await screen.findByText(CARD_PROBLEM)).toBeInTheDocument()
    expect(onToken).not.toHaveBeenCalled()
    // The attempt is over: the shopper can fix the card and pay again.
    await waitFor(() => expect(pay).toBeEnabled())
  })

  it('shows the load-failed view when the SDK cannot load', async () => {
    vi.mocked(loadSquare).mockReturnValue(Promise.resolve(null))
    renderPay()
    expect(await screen.findByText("We couldn't load the payment form")).toBeInTheDocument()
  })

  it('offers only the wallets this device supports; Google Pay tokenizes on click', async () => {
    const { google, request, payments } = fakeSquare({ googlePay: true })
    const { onToken } = renderPay()
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Pay with Apple Pay' })).not.toBeInTheDocument()
    expect(payments.paymentRequest).toHaveBeenCalledWith({ countryCode: 'US', currencyCode: 'USD', total: { amount: '115.93', label: STORE_LABEL } })
    expect(payments.googlePay).toHaveBeenCalledWith(request)
    expect(google.attach).toHaveBeenCalled()
    await userEvent.click(gp)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_google'))
  })

  it('Apple Pay calls tokenize synchronously inside the click, before any await', async () => {
    const { apple } = fakeSquare({ applePay: true })
    const { onToken } = renderPay()
    const ap = await screen.findByRole('button', { name: 'Pay with Apple Pay' })
    // fireEvent dispatches synchronously; if the handler awaited anything
    // before tokenize(), the call would still be queued as a microtask here.
    fireEvent.click(ap)
    expect(apple.tokenize).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_apple'))
  })

  it('updates the wallet total after a re-quote, and cleans up on unmount', async () => {
    const { request, card } = fakeSquare()
    const view = renderPay()
    // Enabled means 'ready': the payment request exists by then.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay $115.93' })).toBeEnabled())
    view.rerender(<SquarePayment config={CONFIG} amountCents={12000} contact={CONTACT} disabled={false} onToken={vi.fn()} />)
    await waitFor(() => expect(request.update).toHaveBeenCalledWith({ total: { amount: '120.00', label: STORE_LABEL } }))
    view.unmount()
    expect(card.destroy).toHaveBeenCalled()
  })

  it('does nothing while disabled, even when a pay control is clicked', async () => {
    const { card, apple, google } = fakeSquare({ applePay: true, googlePay: true })
    renderPay({ disabled: true })
    // Google Pay attaches last, so once it shows the form is fully ready:
    // the only thing stopping a payment below is `disabled`.
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })
    expect(pay).toBeDisabled()
    await userEvent.click(pay)
    await userEvent.click(screen.getByRole('button', { name: 'Pay with Apple Pay' }))
    await userEvent.click(gp)
    fireEvent.click(pay)
    expect(card.tokenize).not.toHaveBeenCalled()
    expect(apple.tokenize).not.toHaveBeenCalled()
    expect(google.tokenize).not.toHaveBeenCalled()
  })

  it('allows one payment at a time and reports while one is in flight', async () => {
    const tokenized = deferred<unknown>()
    const paid = deferred<void>()
    const { card, google } = fakeSquare({ googlePay: true, cardTokenize: () => tokenized.promise })
    const onPayingChange = vi.fn()
    const onToken = vi.fn(() => paid.promise)
    renderPay({ onToken, onPayingChange })
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })

    await userEvent.click(pay)
    expect(card.tokenize).toHaveBeenCalledTimes(1)
    expect(onPayingChange).toHaveBeenLastCalledWith(true)
    expect(pay).toBeDisabled()
    await userEvent.click(gp)
    expect(google.tokenize).not.toHaveBeenCalled()

    // Tokenized; the page is now charging (onToken's promise is pending).
    tokenized.resolve({ status: 'OK', token: 'tok_card' })
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_card'))
    await userEvent.click(gp)
    expect(google.tokenize).not.toHaveBeenCalled()
    expect(onPayingChange).not.toHaveBeenCalledWith(false)

    paid.resolve()
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    await waitFor(() => expect(pay).toBeEnabled())
  })

  it('ignores a second click before the first has re-rendered', async () => {
    const tokenized = deferred<unknown>()
    const { google } = fakeSquare({ googlePay: true, googleTokenize: () => tokenized.promise })
    renderPay()
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    fireEvent.click(gp)
    fireEvent.click(gp)
    expect(google.tokenize).toHaveBeenCalledTimes(1)
    tokenized.resolve({ status: 'Cancel' })
  })

  it('a cancelled wallet sheet shows no error and frees the pay controls', async () => {
    const { card } = fakeSquare({ googlePay: true, googleTokenize: async () => ({ status: 'Cancel' }) })
    const onPayingChange = vi.fn()
    const { onToken } = renderPay({ onPayingChange })
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    await userEvent.click(gp)
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByText(CARD_PROBLEM)).not.toBeInTheDocument()
    expect(onToken).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Pay $115.93' }))
    expect(card.tokenize).toHaveBeenCalledTimes(1)
  })
})

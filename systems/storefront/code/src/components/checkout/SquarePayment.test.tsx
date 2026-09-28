import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/**
 * Waits until the init effect has run to its end (Google Pay is its last
 * step, attached or refused) and flushes the resulting render, so the
 * assertions and unmount that follow raise no act() warnings.
 */
async function initDone(f: ReturnType<typeof fakeSquare>, googlePay = false) {
  await waitFor(() => expect(f.payments.googlePay).toHaveBeenCalled())
  if (googlePay) {
    await waitFor(() => expect(f.google.attach).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('google-pay-container')).toBeVisible())
  }
  await act(async () => {})
}

/** A user click whose async aftermath (tokenize, onToken, release) is flushed inside act(). */
async function press(el: HTMLElement) {
  await act(async () => {
    await userEvent.click(el)
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => vi.clearAllMocks())

describe('SquarePayment', () => {
  it('announces the loading payment form as a status', async () => {
    const f = fakeSquare()
    renderPay()
    expect(screen.getByRole('status')).toHaveTextContent('Loading the payment form…')
    await initDone(f)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('leaves the Google Pay container unlabelled: Square renders its own button inside it', async () => {
    const f = fakeSquare({ googlePay: true })
    renderPay()
    await initDone(f, true)
    const gp = screen.getByTestId('google-pay-container')
    for (const attr of ['role', 'aria-label', 'aria-disabled']) expect(gp).not.toHaveAttribute(attr)
    expect(screen.queryByRole('button', { name: 'Pay with Google Pay' })).not.toBeInTheDocument()
  })
  it('attaches the card form at the configured location and tokenizes with verification details', async () => {
    const f = fakeSquare()
    const { square, card } = f
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    await initDone(f)
    expect(square.payments).toHaveBeenCalledWith('sandbox-sq0idb-test', 'LONLINE')
    expect(card.attach).toHaveBeenCalledWith(screen.getByTestId('card-container'))
    await press(pay)
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
    const f = fakeSquare()
    render(<SquarePayment config={CONFIG} amountCents={11593} contact={{ ...CONTACT, address: { ...CONTACT.address, line2: '' } }}
      disabled={false} onToken={vi.fn()} />)
    await initDone(f)
    await press(screen.getByRole('button', { name: 'Pay $115.93' }))
    expect(f.card.tokenize).toHaveBeenCalledWith(expect.objectContaining({
      billingContact: expect.objectContaining({ addressLines: ['1 Main St'] }),
    }))
  })

  it('asks the shopper to check the card when tokenize fails, without calling onToken', async () => {
    const f = fakeSquare({ tokenize: { status: 'Invalid', errors: [] } })
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    await initDone(f)
    await press(pay)
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

  it('logs why the form failed to initialise and shows the load-failed view', async () => {
    const f = fakeSquare()
    const boom = new Error('bad application id')
    f.payments.card.mockRejectedValueOnce(boom)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderPay()
      expect(await screen.findByText("We couldn't load the payment form")).toBeInTheDocument()
      expect(log).toHaveBeenCalledWith(expect.any(String), boom)
    } finally {
      log.mockRestore()
    }
  })

  it('destroys, and never attaches, a card created after unmount', async () => {
    const f = fakeSquare()
    const made = deferred<typeof f.card>()
    f.payments.card.mockReturnValueOnce(made.promise)
    const view = renderPay()
    await waitFor(() => expect(f.payments.card).toHaveBeenCalled())
    view.unmount()
    made.resolve(f.card)
    await waitFor(() => expect(f.card.destroy).toHaveBeenCalled())
    expect(f.card.attach).not.toHaveBeenCalled()
    expect(f.payments.paymentRequest).not.toHaveBeenCalled()
  })

  it('stops setting up when unmounted while the card form is attaching', async () => {
    const f = fakeSquare()
    const attached = deferred<void>()
    f.card.attach.mockReturnValueOnce(attached.promise)
    const view = renderPay()
    await waitFor(() => expect(f.card.attach).toHaveBeenCalled())
    view.unmount()
    attached.resolve()
    await waitFor(() => expect(f.card.destroy).toHaveBeenCalled())
    await act(async () => {})
    expect(f.payments.paymentRequest).not.toHaveBeenCalled()
    expect(f.payments.applePay).not.toHaveBeenCalled()
  })

  it('offers only the wallets this device supports; Google Pay tokenizes on click', async () => {
    const f = fakeSquare({ googlePay: true })
    const { google, request, payments } = f
    const { onToken } = renderPay()
    const gp = await screen.findByTestId('google-pay-container')
    await initDone(f, true)
    expect(screen.queryByRole('button', { name: 'Pay with Apple Pay' })).not.toBeInTheDocument()
    expect(payments.paymentRequest).toHaveBeenCalledWith({ countryCode: 'US', currencyCode: 'USD', total: { amount: '115.93', label: STORE_LABEL } })
    expect(payments.googlePay).toHaveBeenCalledWith(request)
    expect(google.attach).toHaveBeenCalled()
    await press(gp)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_google'))
  })

  it('Apple Pay calls tokenize synchronously inside the click, before any await', async () => {
    const f = fakeSquare({ applePay: true })
    const { onToken } = renderPay()
    await initDone(f)
    const ap = screen.getByRole('button', { name: 'Pay with Apple Pay' })
    // fireEvent dispatches synchronously; if the handler awaited anything
    // before tokenize(), the call would still be queued as a microtask here.
    fireEvent.click(ap)
    expect(f.apple.tokenize).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_apple'))
  })

  it('updates the wallet total after a re-quote, and cleans up on unmount', async () => {
    const f = fakeSquare()
    const { request, card } = f
    const view = renderPay()
    // Enabled means 'ready': the payment request exists by then.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay $115.93' })).toBeEnabled())
    await initDone(f)
    view.rerender(<SquarePayment config={CONFIG} amountCents={12000} contact={CONTACT} disabled={false} onToken={vi.fn()} />)
    await waitFor(() => expect(request.update).toHaveBeenCalledWith({ total: { amount: '120.00', label: STORE_LABEL } }))
    view.unmount()
    expect(card.destroy).toHaveBeenCalled()
  })

  it('does nothing while disabled, even when a pay control is clicked', async () => {
    const f = fakeSquare({ applePay: true, googlePay: true })
    renderPay({ disabled: true })
    // Google Pay attaches last, so once it shows the form is fully ready:
    // the only thing stopping a payment below is `disabled`.
    await initDone(f, true)
    const gp = screen.getByTestId('google-pay-container')
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })
    expect(pay).toBeDisabled()
    await press(pay)
    await press(screen.getByRole('button', { name: 'Pay with Apple Pay' }))
    await press(gp)
    fireEvent.click(pay)
    expect(f.card.tokenize).not.toHaveBeenCalled()
    expect(f.apple.tokenize).not.toHaveBeenCalled()
    expect(f.google.tokenize).not.toHaveBeenCalled()
  })

  it('allows one payment at a time and reports while one is in flight', async () => {
    const tokenized = deferred<unknown>()
    const paid = deferred<void>()
    const f = fakeSquare({ googlePay: true, cardTokenize: () => tokenized.promise })
    const onPayingChange = vi.fn()
    const onToken = vi.fn(() => paid.promise)
    renderPay({ onToken, onPayingChange })
    await initDone(f, true)
    const gp = screen.getByTestId('google-pay-container')
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })

    await press(pay)
    expect(f.card.tokenize).toHaveBeenCalledTimes(1)
    expect(onPayingChange).toHaveBeenLastCalledWith(true)
    expect(pay).toBeDisabled()
    await press(gp)
    expect(f.google.tokenize).not.toHaveBeenCalled()

    // Tokenized; the page is now charging (onToken's promise is pending).
    tokenized.resolve({ status: 'OK', token: 'tok_card' })
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_card'))
    await press(gp)
    expect(f.google.tokenize).not.toHaveBeenCalled()
    expect(onPayingChange).not.toHaveBeenCalledWith(false)

    paid.resolve()
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    await waitFor(() => expect(pay).toBeEnabled())
  })

  it('ignores a second click before the first has re-rendered', async () => {
    const tokenized = deferred<unknown>()
    const f = fakeSquare({ googlePay: true, googleTokenize: () => tokenized.promise })
    const onPayingChange = vi.fn()
    renderPay({ onPayingChange })
    await initDone(f, true)
    const gp = screen.getByTestId('google-pay-container')
    fireEvent.click(gp)
    fireEvent.click(gp)
    expect(f.google.tokenize).toHaveBeenCalledTimes(1)
    tokenized.resolve({ status: 'Cancel' })
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
  })

  it('a cancelled wallet sheet shows no error and frees the pay controls', async () => {
    const f = fakeSquare({ googlePay: true, googleTokenize: async () => ({ status: 'Cancel' }) })
    const onPayingChange = vi.fn()
    const { onToken } = renderPay({ onPayingChange })
    await initDone(f, true)
    await press(screen.getByTestId('google-pay-container'))
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByText(CARD_PROBLEM)).not.toBeInTheDocument()
    expect(onToken).not.toHaveBeenCalled()
    await press(screen.getByRole('button', { name: 'Pay $115.93' }))
    expect(f.card.tokenize).toHaveBeenCalledTimes(1)
  })

  it('a wallet tokenize that throws synchronously does not lock the pay controls', async () => {
    const f = fakeSquare({ googlePay: true, googleTokenize: () => { throw new Error('sheet unavailable') } })
    const onPayingChange = vi.fn()
    const { onToken } = renderPay({ onPayingChange })
    await initDone(f, true)
    await press(screen.getByTestId('google-pay-container'))
    expect(f.google.tokenize).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(CARD_PROBLEM)).toBeInTheDocument()
    expect(onPayingChange).not.toHaveBeenLastCalledWith(true)
    await press(screen.getByRole('button', { name: 'Pay $115.93' }))
    expect(f.card.tokenize).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_card'))
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
  })

  it('a card tokenize that rejects shows the card problem, releases, and can be retried', async () => {
    const f = fakeSquare()
    f.card.tokenize.mockRejectedValueOnce(new Error('tokenization failed'))
    const onPayingChange = vi.fn()
    const { onToken } = renderPay({ onPayingChange })
    await initDone(f)
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })
    await press(pay)
    expect(await screen.findByText(CARD_PROBLEM)).toBeInTheDocument()
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    expect(onToken).not.toHaveBeenCalled()
    await press(pay)
    expect(f.card.tokenize).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_card'))
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
  })

  it('a wallet tokenize that rejects shows the card problem, releases, and can be retried', async () => {
    const f = fakeSquare({ googlePay: true })
    f.google.tokenize.mockRejectedValueOnce(new Error('tokenization failed'))
    const onPayingChange = vi.fn()
    const { onToken } = renderPay({ onPayingChange })
    await initDone(f, true)
    const gp = screen.getByTestId('google-pay-container')
    await press(gp)
    expect(await screen.findByText(CARD_PROBLEM)).toBeInTheDocument()
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    await press(gp)
    expect(f.google.tokenize).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_google'))
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
  })

  it('a rejected pay call from the page releases the controls without a card error', async () => {
    const f = fakeSquare()
    const onPayingChange = vi.fn()
    const onToken = vi.fn<(t: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('payment_declined'))
      .mockResolvedValueOnce(undefined)
    renderPay({ onToken, onPayingChange })
    await initDone(f)
    const pay = screen.getByRole('button', { name: 'Pay $115.93' })
    await press(pay)
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByText(CARD_PROBLEM)).not.toBeInTheDocument()
    await waitFor(() => expect(pay).toBeEnabled())
    await press(pay)
    expect(f.card.tokenize).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onToken).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onPayingChange).toHaveBeenLastCalledWith(false))
  })
})

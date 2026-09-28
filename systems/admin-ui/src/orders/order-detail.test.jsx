import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import OrderDetail from './OrderDetail.jsx'
import detail from '../data/__fixtures__/order-detail.json'
import { AdminApiError } from '../data/errors.js'
import { formatCents } from '../lib/money.js'

vi.mock('../data/api.js', () => ({ default: { getOrder: vi.fn(), shipOrder: vi.fn(), cancelOrder: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

function renderDetail(order = detail) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/orders/${order.id}`]}>
        <Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('OrderDetail', () => {
  it('shows lines, address, money, referral and the payment reference, naming no provider', async () => {
    renderDetail()
    expect(await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })).toBeInTheDocument()
    expect(screen.getByText(detail.lines[0].name)).toBeInTheDocument()
    expect(screen.getByText(detail.shipTo.line1)).toBeInTheDocument()
    expect(screen.getByText('unmatched')).toBeInTheDocument()
    expect(screen.getByText('Payment ID')).toBeInTheDocument()
    expect(screen.getByText(detail.payment.id)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View payment' })).not.toBeInTheDocument() // url is null until §9.3
    expect(screen.getByText('Refunds are issued in the payment dashboard.')).toBeInTheDocument()
    expect(document.body.textContent.toLowerCase()).not.toMatch(/stripe|square/)
    expect(screen.getByText('order.paid')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument() // paid: refund in the payment dashboard
  })

  it('links to the payment when core supplies a URL', async () => {
    renderDetail({ ...detail, payment: { ...detail.payment, url: 'https://example.test/payments/sqpay_fixture' } })
    expect(await screen.findByRole('link', { name: 'View payment' })).toHaveAttribute('href', 'https://example.test/payments/sqpay_fixture')
  })

  it('shows no payment reference for an unpaid order', async () => {
    renderDetail({ ...detail, status: 'pending', payment: null })
    await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })
    expect(screen.queryByText('Payment ID')).not.toBeInTheDocument()
  })

  it('formats every money row as currency, not raw cents (regression: C-R2)', async () => {
    // Distinct non-zero values for subtotal/shipping/tax/total/refund so a
    // row silently rendering raw cents (e.g. "18900") can't hide behind a
    // fixture value that happens to look plausible either way.
    renderDetail({
      ...detail,
      subtotalCents: 4999, shippingCents: 995, taxCents: 357, totalCents: 6351, refundedCents: 1200,
    })
    await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })
    expect(screen.getByText(formatCents(4999))).toBeInTheDocument() // Subtotal: $49.99
    expect(screen.getByText(formatCents(995))).toBeInTheDocument() // Shipping: $9.95
    expect(screen.getByText(formatCents(357))).toBeInTheDocument() // Tax: $3.57
    expect(screen.getByText(formatCents(6351))).toBeInTheDocument() // Total: $63.51
    expect(screen.getByText(formatCents(1200))).toBeInTheDocument() // Refunded: $12.00
    expect(screen.queryByText('4999')).not.toBeInTheDocument()
    expect(screen.queryByText('995')).not.toBeInTheDocument()
  })

  it('marks shipped: tracking required unless Other', async () => {
    const shipped = { ...detail, status: 'fulfilled', carrier: 'USPS', trackingNumber: '9400', shippedAt: '2026-09-28T10:00:00.000Z' }
    vi.mocked(api.shipOrder).mockResolvedValue(shipped)
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Mark shipped' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '9400')
    await userEvent.click(confirm)
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'USPS', trackingNumber: '9400' })
    expect(await screen.findByText('Shipped')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('allows Other without tracking', async () => {
    vi.mocked(api.shipOrder).mockResolvedValue({ ...detail, status: 'fulfilled', carrier: 'Other' })
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByLabelText('Carrier'), 'Other')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'Other' })
  })

  it('requires the review acknowledgement for a flagged order', async () => {
    vi.mocked(api.shipOrder).mockResolvedValue({ ...detail, status: 'fulfilled' })
    renderDetail({ ...detail, reviewReason: 'outside_shipping_area' })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '1Z9')
    const confirm = within(dialog).getByRole('button', { name: 'Mark shipped' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /reviewed it/i }))
    await userEvent.click(confirm)
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'USPS', trackingNumber: '1Z9', acknowledgeReview: true })
  })

  it('shows core’s error in the dialog and keeps it open', async () => {
    vi.mocked(api.shipOrder).mockRejectedValue(new AdminApiError('invalid input', 'VALIDATION_ERROR', { trackingNumber: 'letters, numbers, spaces and hyphens, at most 64' }))
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '###')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('tracking number: letters')
  })

  it('cancels a pending order after confirmation', async () => {
    vi.mocked(api.cancelOrder).mockResolvedValue({ ...detail, status: 'cancelled' })
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel order' }))
    expect(api.cancelOrder).toHaveBeenCalledWith(detail.id)
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
  })

  it('describes a pending cancel without naming a payment provider', async () => {
    renderDetail({ ...detail, status: 'pending', payment: null })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText("This cancels the customer's checkout and returns the items to stock.")).toBeInTheDocument()
  })

  it('explains a cancel refused because the customer is paying right now', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('The customer is paying for this order right now. Wait ten minutes, then refresh.', 'PAYMENT_IN_PROGRESS'))
    renderDetail({ ...detail, status: 'pending', payment: null })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/paying for this order right now/)
  })

  it('explains when the customer paid before the cancel landed, inside the modal, and refreshes the order', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('The customer has just paid for this order.', 'ORDER_PAID'))
    vi.mocked(api.getOrder)
      .mockResolvedValueOnce({ ...detail, status: 'pending' })
      .mockResolvedValueOnce({ ...detail, status: 'paid' })
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/has just paid/)
    // The page behind the modal refreshes once the refetch lands: a paid,
    // non-disputed order drops the header's own "Cancel order" button, so
    // only the modal's confirm button (same label) is left.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Cancel order' })).toHaveLength(1))
  })

  it('shows Cancel for a paid+disputed order behind an acknowledgement checkbox', async () => {
    vi.mocked(api.cancelOrder).mockResolvedValue({ ...detail, status: 'cancelled' })
    renderDetail({ ...detail, status: 'paid', reviewReason: 'disputed' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Cancel order' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /disputed/i }))
    await userEvent.click(confirm)
    expect(api.cancelOrder).toHaveBeenCalledWith(detail.id, { acknowledgeReview: true })
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
  })

  it('does not offer Cancel for a paid order that is not disputed', async () => {
    renderDetail({ ...detail, status: 'paid', reviewReason: 'outside_shipping_area' })
    await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument()
  })

  it('maps a 409 REVIEW_REQUIRED response from core to readable text, inside the modal', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('This order needs the review acknowledged before it can be cancelled.', 'REVIEW_REQUIRED'))
    renderDetail({ ...detail, status: 'paid', reviewReason: 'disputed' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /disputed/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/needs the review acknowledged/)
  })

  it('clears a stale cancel error and re-shows the acknowledgement copy each time the modal reopens', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValueOnce(new AdminApiError('boom', 'INTERNAL'))
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    let dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('boom')
    // Dismiss with "Cancel" (this order isn't disputed, so no rename) and reopen.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('describes a disputed cancel without naming a payment provider, and calls the dismiss button "Keep order"', async () => {
    renderDetail({ ...detail, status: 'paid', reviewReason: 'disputed' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/cancels the order and returns the items to stock/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/stripe|square/i)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep order' })).toBeInTheDocument()
  })

  it('shows "resolves when paid" for a referral core has not resolved to a partner yet', async () => {
    renderDetail({ ...detail, status: 'pending', referral: { code: 'club', partnerName: null, commissionRateBps: null, unmatched: false } })
    expect(await screen.findByText('club · resolves when paid')).toBeInTheDocument()
  })

  it('shows tax and total as pending until the address is quoted', async () => {
    renderDetail({ ...detail, taxJurisdiction: 'quote_pending' })
    await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(screen.getByText('pending tax')).toBeInTheDocument()
  })

  it('recovers the acknowledgement checkbox when core flags an order that looked clean (details.reviewReason)', async () => {
    vi.mocked(api.shipOrder).mockRejectedValueOnce(
      new AdminApiError('This order is flagged. Confirm you have reviewed it before shipping.', 'REVIEW_REQUIRED', undefined, { reviewReason: 'amount_mismatch' }),
    )
    renderDetail({ ...detail, status: 'paid', reviewReason: null })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '9400')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(await within(dialog).findByRole('checkbox', { name: /reviewed it/i })).toBeInTheDocument()
    expect(within(dialog).getByText(/amount mismatch/i)).toBeInTheDocument()
  })

  it('recovers the acknowledgement checkbox by refetching when core omits details.reviewReason', async () => {
    vi.mocked(api.shipOrder).mockRejectedValueOnce(new AdminApiError('flagged', 'REVIEW_REQUIRED'))
    vi.mocked(api.getOrder)
      .mockResolvedValueOnce({ ...detail, status: 'paid', reviewReason: null })
      .mockResolvedValueOnce({ ...detail, status: 'paid', reviewReason: 'disputed' })
    renderDetail({ ...detail, status: 'paid', reviewReason: null })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '9400')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(await within(dialog).findByRole('checkbox', { name: /reviewed it/i })).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import OrderDetail from './OrderDetail.jsx'
import detail from '../data/__fixtures__/order-detail.json'
import { AdminApiError } from '../data/errors.js'

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
  it('shows lines, address, money, referral and the Stripe link', async () => {
    renderDetail()
    expect(await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })).toBeInTheDocument()
    expect(screen.getByText(detail.lines[0].name)).toBeInTheDocument()
    expect(screen.getByText(detail.shipTo.line1)).toBeInTheDocument()
    expect(screen.getByText('unmatched')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view payment in stripe/i })).toHaveAttribute('href', detail.stripePaymentUrl)
    expect(screen.getByText('order.paid')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument() // paid: refund in Stripe
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

  it('explains when the customer paid before the cancel landed', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('The customer has just paid for this order.', 'ORDER_PAID'))
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel order' }))
    expect(await screen.findByText(/has just paid/)).toBeInTheDocument()
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

  it('maps a 409 REVIEW_REQUIRED response from core to readable text', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('This order needs the review acknowledged before it can be cancelled.', 'REVIEW_REQUIRED'))
    renderDetail({ ...detail, status: 'paid', reviewReason: 'disputed' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /disputed/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await screen.findByText(/needs the review acknowledged/)).toBeInTheDocument()
  })
})

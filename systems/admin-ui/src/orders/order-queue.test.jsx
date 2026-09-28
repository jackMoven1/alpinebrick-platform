import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import OrderQueue from './OrderQueue.jsx'
import queue from '../data/__fixtures__/order-queue.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { listOrders: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const renderQueue = (url = '/orders') => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="/orders" element={<OrderQueue />} /></Routes></MemoryRouter>,
)

describe('OrderQueue', () => {
  it('lists the To ship queue by default with core’s rows', async () => {
    vi.mocked(api.listOrders).mockResolvedValue(queue)
    renderQueue()
    const row = await screen.findByRole('row', { name: new RegExp(queue.items[0].orderNumber) })
    expect(within(row).getByRole('link', { name: queue.items[0].orderNumber })).toHaveAttribute('href', `/orders/${queue.items[0].id}`)
    expect(within(row).getByText(queue.items[0].email)).toBeInTheDocument()
    expect(within(row).getByText('MI')).toBeInTheDocument()
    expect(api.listOrders).toHaveBeenCalledWith({ tab: 'to_ship', page: 1, pageSize: 25 })
    expect(screen.getByRole('tab', { name: 'To ship' })).toHaveAttribute('aria-selected', 'true')
  })

  it('switches tabs', async () => {
    vi.mocked(api.listOrders).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 })
    renderQueue()
    // Let the initial to_ship fetch settle before switching tabs, so its
    // state update lands inside this act() rather than racing the click.
    await screen.findByText('No orders here.')
    await act(async () => { await userEvent.click(screen.getByRole('tab', { name: 'Needs review' })) })
    expect(api.listOrders).toHaveBeenLastCalledWith({ tab: 'review', page: 1, pageSize: 25 })
    expect(await screen.findByText('No orders here.')).toBeInTheDocument()
  })

  it('shows a review reason and a placeholder for pending orders without an email', async () => {
    vi.mocked(api.listOrders).mockResolvedValue({ ...queue, items: [{ ...queue.items[0], email: null, shipToState: null, reviewReason: 'outside_shipping_area' }] })
    renderQueue('/orders?tab=review')
    expect(await screen.findByText('Outside shipping area')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBe(2)
  })

  it('shows core’s error', async () => {
    vi.mocked(api.listOrders).mockRejectedValue(new AdminApiError('Server unavailable', 'INTERNAL'))
    renderQueue()
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable')
  })
})

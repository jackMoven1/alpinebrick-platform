import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductList from './ProductList.jsx'
import result from '../data/__fixtures__/bulk-status.json'

vi.mock('../data/api.js', () => ({ default: { listProducts: vi.fn(), bulkSetStatus: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const items = result.results.map((r, i) => ({ id: r.id, slug: `s${i}`, name: `Product ${i}`, status: 'draft', categories: [], variantCount: 1, imageCount: 0, updatedAt: '2026-09-24T00:00:00.000Z' }))

describe('bulk status', () => {
  it('publishes the selection and lists per-product failures', async () => {
    vi.mocked(api.listProducts).mockResolvedValue({ items, total: items.length, page: 1, pageSize: 20 })
    vi.mocked(api.bulkSetStatus).mockResolvedValue(result)
    render(<ToastProvider><MemoryRouter><ProductList /></MemoryRouter></ToastProvider>)
    for (const box of await screen.findAllByRole('checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: /publish \(2\)/i }))
    expect(api.bulkSetStatus).toHaveBeenCalledWith(items.map((i) => i.id), 'published')
    const failed = result.results.find((r) => !r.ok)
    expect(await screen.findByText(new RegExp(failed.message))).toBeInTheDocument()
  })

  it('shows the error message when the bulk call rejects outright', async () => {
    vi.mocked(api.listProducts).mockResolvedValue({ items, total: items.length, page: 1, pageSize: 20 })
    vi.mocked(api.bulkSetStatus).mockRejectedValue(new Error('network error'))
    render(<ToastProvider><MemoryRouter><ProductList /></MemoryRouter></ToastProvider>)
    for (const box of await screen.findAllByRole('checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: /publish \(2\)/i }))
    expect(await screen.findByText(/network error/i)).toBeInTheDocument()
  })
})

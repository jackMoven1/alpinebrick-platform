import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductDetail from './ProductDetail.jsx'

// ProductDetail now calls core rather than the mock, so the API is stubbed
// here. The product shape is core's DTO: priceCents (not a float `price`),
// and images as storage keys.
vi.mock('../data/api.js', () => ({
  default: { getProduct: vi.fn(), setProductStatus: vi.fn() },
}))
import api from '../data/api.js'

const PRODUCT = {
  id: 'prod-001', slug: 'classic-brick-set', name: 'Classic Brick Set',
  description: 'A classic.', status: 'draft', categories: ['starter'],
  variants: [{ id: 'v1', sku: 'CBS-1', priceCents: 1250, currency: 'USD' }],
  images: [{ storageKey: 'products/prod-001/i1/original.jpg', alt: 'Front', width: 900, height: 720, position: 0 }],
}

function renderDetail() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/products/prod-001']}>
        <Routes><Route path="/products/:id" element={<ProductDetail />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

afterEach(() => vi.clearAllMocks())

describe('ProductDetail', () => {
  it('loads a product and shows tabs', async () => {
    vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
    renderDetail()
    expect(await screen.findByText('Classic Brick Set')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Variants' })).toBeInTheDocument()
  })

  /**
   * This replaces a test that used to add a variant through the Variants tab.
   * That capability was deliberately removed for the Phase B slice — createVariant
   * has no endpoint in core — so the assertion now documents what the tab
   * actually does. The old test is not "fixed"; the behaviour changed, and the
   * test says so.
   */
  it('renders the Variants tab read-only, with no enabled control', async () => {
    vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
    const user = userEvent.setup()
    renderDetail()
    await screen.findByText('Classic Brick Set')
    await user.click(screen.getByRole('button', { name: 'Variants' }))

    expect(screen.getByText(/not in this phase/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('SKU')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add variant' })).toBeDisabled()
  })

  // Core returns integer cents; the old mock returned a float `price`, and
  // calling .toFixed on that would throw against real data.
  it('formats variant price from integer cents', async () => {
    vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
    const user = userEvent.setup()
    renderDetail()
    await screen.findByText('Classic Brick Set')
    await user.click(screen.getByRole('button', { name: 'Variants' }))
    expect(screen.getByText('$12.50')).toBeInTheDocument()
  })
})

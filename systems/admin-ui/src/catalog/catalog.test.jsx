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
  variants: [{
    id: 'v1', sku: 'CBS-1', priceCents: 1250, currency: 'USD', attributes: {},
    inventory: { onHand: 2, reserved: 0, walmartAllocation: null, storefrontAvailable: 2, walmartAvailable: 2 },
    locked: { sku: false, delete: false }, walmartListing: null,
  }],
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
   * History: this was once an add-variant test, then (Phase B slice, no core
   * endpoint) an assertion that the tab was read-only. Task 13 made variants
   * live, so it now asserts the live controls. The behaviour changed twice;
   * the test says so each time.
   */
  it('renders the Variants tab live: add is enabled once SKU and price are filled', async () => {
    vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
    const user = userEvent.setup()
    renderDetail()
    await screen.findByText('Classic Brick Set')
    await user.click(screen.getByRole('button', { name: 'Variants' }))

    expect(screen.queryByText(/not in this phase/i)).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('SKU')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add variant' })).toBeDisabled()
    await user.type(screen.getByPlaceholderText('SKU'), 'CBS-2')
    await user.type(screen.getByPlaceholderText('Price $'), '9.99')
    expect(screen.getByRole('button', { name: 'Add variant' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Set stock' })).toBeEnabled()
  })

  // Core returns integer cents; the old mock returned a float `price`, and
  // calling .toFixed on that would throw against real data.
  it('formats variant price from integer cents', async () => {
    vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
    const user = userEvent.setup()
    renderDetail()
    await screen.findByText('Classic Brick Set')
    await user.click(screen.getByRole('button', { name: 'Variants' }))
    // The price is now an editable dollars field, rendered from cents exactly once.
    expect(screen.getByLabelText('Price CBS-1')).toHaveValue('12.50')
  })

  // spec §6: leaving Info with unsaved edits asks first, everywhere — not
  // just on a browser tab close.
  describe('unsaved Info edits guard tab switching', () => {
    it('stays on Info when the confirm is declined', async () => {
      vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
      const user = userEvent.setup()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      renderDetail()
      await screen.findByText('Classic Brick Set')
      await user.clear(screen.getByLabelText('Name'))
      await user.type(screen.getByLabelText('Name'), 'Renamed Set')
      await user.click(screen.getByRole('button', { name: 'Variants' }))

      expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes to this product?')
      expect(screen.getByLabelText('Name')).toHaveValue('Renamed Set')
      confirmSpy.mockRestore()
    })

    it('switches tabs when the confirm is accepted', async () => {
      vi.mocked(api.getProduct).mockResolvedValue(PRODUCT)
      const user = userEvent.setup()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderDetail()
      await screen.findByText('Classic Brick Set')
      await user.clear(screen.getByLabelText('Name'))
      await user.type(screen.getByLabelText('Name'), 'Renamed Set')
      await user.click(screen.getByRole('button', { name: 'Variants' }))

      expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes to this product?')
      expect(screen.getByRole('button', { name: 'Add variant' })).toBeInTheDocument()
      confirmSpy.mockRestore()
    })
  })
})

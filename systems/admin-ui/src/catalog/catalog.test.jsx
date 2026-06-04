import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductDetail from './ProductDetail.jsx'

function renderDetail(id) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/products/${id}`]}>
        <Routes><Route path="/products/:id" element={<ProductDetail />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('ProductDetail', () => {
  it('loads a product and shows tabs', async () => {
    renderDetail('prod-001')
    expect(await screen.findByText('Classic Brick Set')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Variants' })).toBeInTheDocument()
  })

  it('adds a variant through the Variants tab', async () => {
    const user = userEvent.setup()
    renderDetail('prod-002') // starts with 0 variants
    await screen.findByText('Space Rover Kit')
    await user.click(screen.getByRole('button', { name: 'Variants' }))
    await user.type(screen.getByPlaceholderText('SKU'), 'SR-NEW')
    // The Variants tab renders two "Price" inputs (single-add form + bulk form);
    // target the single-add form's input, which is rendered first.
    await user.type(screen.getAllByPlaceholderText('Price')[0], '12.50')
    await user.click(screen.getByRole('button', { name: 'Add variant' }))
    await waitFor(() => expect(screen.getByText('SR-NEW')).toBeInTheDocument())
  })
})

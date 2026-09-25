import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductForm from './ProductForm.jsx'
import product from '../data/__fixtures__/product.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { createProduct: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

function renderForm() {
  return render(
    <ToastProvider><MemoryRouter initialEntries={['/products/new']}>
      <Routes>
        <Route path="/products/new" element={<ProductForm />} />
        <Route path="/products/:id" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter></ToastProvider>,
  )
}

describe('ProductForm', () => {
  it('requires a type before creating', async () => {
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    expect(screen.getByRole('button', { name: /create product/i })).toBeDisabled()
    await userEvent.click(screen.getByLabelText(/resale/i))
    expect(screen.getByRole('button', { name: /create product/i })).toBeEnabled()
  })

  it('creates and opens the new draft', async () => {
    vi.mocked(api.createProduct).mockResolvedValue(product)
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    await userEvent.click(screen.getByRole('button', { name: /create product/i }))
    expect(api.createProduct).toHaveBeenCalledWith(expect.objectContaining({ name: 'Castle Set', productType: 'resale' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
  })

  it('shows field errors from core', async () => {
    vi.mocked(api.createProduct).mockRejectedValue(new AdminApiError('taken', 'SLUG_TAKEN', { slug: 'already in use' }))
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    await userEvent.click(screen.getByRole('button', { name: /create product/i }))
    expect(await screen.findByText('already in use')).toBeInTheDocument()
  })

  it('shows a failure without fields beside Create, not under Name', async () => {
    vi.mocked(api.createProduct).mockRejectedValue(new AdminApiError('internal error', 'INTERNAL'))
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    const create = screen.getByRole('button', { name: /create product/i })
    await userEvent.click(create)
    const msg = await screen.findByText('internal error')
    expect(create.parentElement).toContainElement(msg)
    expect(screen.getByLabelText('Name').parentElement).not.toHaveTextContent('internal error')
  })

  it('keeps accessible names intact when name and slug errors are both shown', async () => {
    vi.mocked(api.createProduct).mockRejectedValue(
      new AdminApiError('invalid input', 'VALIDATION_ERROR', { name: 'required, 1–200 characters', slug: 'already in use' }),
    )
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    await userEvent.click(screen.getByRole('button', { name: /create product/i }))
    expect(await screen.findByText('required, 1–200 characters')).toBeInTheDocument()
    expect(screen.getByText('already in use')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('URL slug')).toBeInTheDocument()
  })
})

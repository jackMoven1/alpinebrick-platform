import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import InfoTab, { diffPatch, toForm } from './tabs/InfoTab.jsx'
import product from '../data/__fixtures__/product.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { updateProduct: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const renderTab = (p = product, onUpdated = vi.fn()) =>
  render(<ToastProvider><InfoTab product={p} onUpdated={onUpdated} /></ToastProvider>)

describe('diffPatch', () => {
  it('sends only changed fields, typed for core', () => {
    const form = { ...toForm(product), pieces: '1200', features: 'Opening gate\nLights', categories: 'castle, Medieval', difficulty: '' }
    expect(diffPatch(product, form)).toEqual({ pieces: 1200, features: ['Opening gate', 'Lights'], categories: ['castle', 'medieval'] })
  })
  it('is empty when nothing changed', () => expect(diffPatch(product, toForm(product))).toEqual({}))

  it('sends non-numeric pieces input as the raw string, not null, so core rejects it with a field error', () => {
    // product.pieces is 900 (populated); typing "1oo" must not silently clear it.
    const form = { ...toForm(product), pieces: '1oo' }
    expect(diffPatch(product, form)).toEqual({ pieces: '1oo' })
  })

  it('detects non-numeric input as dirty even when starting from an empty pieces value', () => {
    const emptyPieces = { ...product, pieces: null }
    const form = { ...toForm(emptyPieces), pieces: 'abc' }
    expect(diffPatch(emptyPieces, form)).toEqual({ pieces: 'abc' })
  })

  it('still converts a blank pieces value to null', () => {
    const form = { ...toForm(product), pieces: '' }
    expect(diffPatch(product, form)).toEqual({ pieces: null })
  })
})

describe('InfoTab', () => {
  it('saves explicitly, never on keystroke', async () => {
    vi.mocked(api.updateProduct).mockResolvedValue({ ...product, name: 'Castle Deluxe' })
    const onUpdated = vi.fn()
    renderTab(product, onUpdated)
    const save = screen.getByRole('button', { name: /save changes/i })
    expect(save).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Deluxe')
    expect(api.updateProduct).not.toHaveBeenCalled()
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument()
    await userEvent.click(save)
    expect(api.updateProduct).toHaveBeenCalledWith(product.id, { name: 'Castle Deluxe' })
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Castle Deluxe' }))
  })

  it('shows the slug as locked once published', () => {
    renderTab({ ...product, locked: { slug: true } })
    expect(screen.getByLabelText('URL slug')).toHaveAttribute('readonly')
    expect(screen.getByText(/locked because this product has been published/i)).toBeInTheDocument()
  })

  it('renders field errors from core beside the field', async () => {
    vi.mocked(api.updateProduct).mockRejectedValue(new AdminApiError('invalid input', 'VALIDATION_ERROR', { pieces: 'a whole number of at least 1, or empty' }))
    renderTab()
    await userEvent.clear(screen.getByLabelText('Pieces'))
    await userEvent.type(screen.getByLabelText('Pieces'), '0')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText('a whole number of at least 1, or empty')).toBeInTheDocument()
  })

  it('discard clears field errors along with the edits', async () => {
    vi.mocked(api.updateProduct).mockRejectedValue(new AdminApiError('invalid input', 'VALIDATION_ERROR', { pieces: 'a whole number of at least 1, or empty' }))
    renderTab()
    await userEvent.clear(screen.getByLabelText('Pieces'))
    await userEvent.type(screen.getByLabelText('Pieces'), '0')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText('a whole number of at least 1, or empty')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /discard/i }))
    expect(screen.queryByText('a whole number of at least 1, or empty')).not.toBeInTheDocument()
  })

  it('reports dirty state changes via onDirtyChange, including false on unmount', async () => {
    const onDirtyChange = vi.fn()
    const { unmount } = render(
      <ToastProvider><InfoTab product={product} onUpdated={vi.fn()} onDirtyChange={onDirtyChange} /></ToastProvider>,
    )
    expect(onDirtyChange).toHaveBeenCalledWith(false)
    onDirtyChange.mockClear()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Deluxe')
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})

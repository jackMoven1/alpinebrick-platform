import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import product from '../data/__fixtures__/product.json'
import token from '../data/__fixtures__/image-upload-token.json'
import confirmed from '../data/__fixtures__/image-confirmed.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: {
  requestImageUpload: vi.fn(), uploadToStorage: vi.fn(), confirmImage: vi.fn(), getProduct: vi.fn(),
  reorderImages: vi.fn(), updateImageAlt: vi.fn(), deleteImage: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

const img = (id, position, alt = '', extra = {}) => ({ id, storageKey: `products/p/${id}/original.png`, alt, width: 800, height: 600, position, ...extra })
const withImages = { ...product, images: [img('a', 0, 'Front'), img('b', 1)] }
const renderTab = (p = withImages, onUpdated = vi.fn()) =>
  render(<ToastProvider><ImagesTab product={p} onUpdated={onUpdated} /></ToastProvider>)
const card = (id) => screen.getByTestId(`image-${id}`)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ImagesTab manage', () => {
  it('badges the first photo as Main', () => {
    renderTab()
    expect(within(card('a')).getByText('Main')).toBeInTheDocument()
    expect(within(card('b')).queryByText('Main')).toBeNull()
  })

  it('badges the first displayed photo as Main even when positions have gaps, sorted by position', () => {
    renderTab({ ...product, images: [img('c', 5), img('a', 2, 'Front')] })
    const cards = screen.getAllByTestId(/^image-/)
    expect(cards.map((c) => c.dataset.testid)).toEqual(['image-a', 'image-c'])
    expect(within(card('a')).getByText('Main')).toBeInTheDocument()
    expect(within(card('c')).queryByText('Main')).toBeNull()
  })

  it('moves a photo left and saves the new order', async () => {
    vi.mocked(api.reorderImages).mockResolvedValue({ ok: true })
    const fresh = { ...product, images: [img('b', 0), img('a', 1, 'Front')] }
    vi.mocked(api.getProduct).mockResolvedValue(fresh)
    const onUpdated = vi.fn()
    renderTab(withImages, onUpdated)
    await userEvent.click(within(card('b')).getByRole('button', { name: /move left/i }))
    expect(api.reorderImages).toHaveBeenCalledWith(product.id, ['b', 'a'])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(fresh))
  })

  it('moves a photo right', async () => {
    vi.mocked(api.reorderImages).mockResolvedValue({ ok: true })
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    await userEvent.click(within(card('a')).getByRole('button', { name: /move right/i }))
    expect(api.reorderImages).toHaveBeenCalledWith(product.id, ['b', 'a'])
  })

  it('disables left on the first photo and right on the last', () => {
    renderTab()
    expect(within(card('a')).getByRole('button', { name: /move left/i })).toBeDisabled()
    expect(within(card('a')).getByRole('button', { name: /move right/i })).toBeEnabled()
    expect(within(card('b')).getByRole('button', { name: /move left/i })).toBeEnabled()
    expect(within(card('b')).getByRole('button', { name: /move right/i })).toBeDisabled()
  })

  it('saves alt text explicitly and prompts when empty', async () => {
    vi.mocked(api.updateImageAlt).mockResolvedValue(img('b', 1, 'Side view'))
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const c = card('b')
    expect(within(c).getByText(/add a description/i)).toBeInTheDocument()
    expect(within(card('a')).queryByText(/add a description/i)).toBeNull()
    expect(within(c).getByRole('button', { name: /save/i })).toBeDisabled()
    await userEvent.type(within(c).getByLabelText('Description'), 'Side view')
    await userEvent.tab()
    expect(api.updateImageAlt).not.toHaveBeenCalled()
    await userEvent.click(within(c).getByRole('button', { name: /save/i }))
    expect(api.updateImageAlt).toHaveBeenCalledWith('b', 'Side view')
  })

  it('deletes only after confirmation', async () => {
    vi.mocked(api.deleteImage).mockResolvedValue(null)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [img('a', 0, 'Front')] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderTab()
    const del = within(card('b')).getByRole('button', { name: /delete/i })
    await userEvent.click(del)
    expect(confirmSpy).toHaveBeenCalledWith('Delete this photo? This cannot be undone.')
    expect(api.deleteImage).not.toHaveBeenCalled()
    await userEvent.click(del)
    await waitFor(() => expect(api.deleteImage).toHaveBeenCalledWith('b'))
  })

  it('disables a photo\'s buttons while its request is in flight', async () => {
    const d = deferred()
    vi.mocked(api.reorderImages).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const left = within(card('b')).getByRole('button', { name: /move left/i })
    await userEvent.click(left)
    expect(left).toBeDisabled()
    expect(within(card('b')).getByRole('button', { name: /delete/i })).toBeDisabled()
    // Order depends on every photo, so no other card can start a reorder either.
    expect(within(card('a')).getByRole('button', { name: /move right/i })).toBeDisabled()
    await userEvent.click(left)
    expect(api.reorderImages).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve({ ok: true }) })
    await waitFor(() => expect(left).toBeEnabled())
  })

  it('a double-clicked Save sends one request', async () => {
    const d = deferred()
    vi.mocked(api.updateImageAlt).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const c = card('b')
    await userEvent.type(within(c).getByLabelText('Description'), 'Side')
    const save = within(c).getByRole('button', { name: /save/i })
    await userEvent.dblClick(save)
    expect(api.updateImageAlt).toHaveBeenCalledTimes(1)
    expect(save).toBeDisabled()
    expect(within(c).getByLabelText('Description')).toBeDisabled()
    await act(async () => { d.resolve(img('b', 1, 'Side')) })
  })

  it('shows core\'s message on the card that failed', async () => {
    vi.mocked(api.deleteImage).mockRejectedValue(new AdminApiError('photo is locked', 'conflict'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderTab()
    await userEvent.click(within(card('b')).getByRole('button', { name: /delete/i }))
    expect(await within(card('b')).findByText('photo is locked')).toBeInTheDocument()
    expect(within(card('a')).queryByText('photo is locked')).toBeNull()
    expect(api.getProduct).not.toHaveBeenCalled()
    expect(within(card('b')).getByRole('button', { name: /delete/i })).toBeEnabled()
  })

  it('never shows or reorders a pending photo', async () => {
    vi.mocked(api.reorderImages).mockResolvedValue({ ok: true })
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab({ ...product, images: [img('a', 0, 'Front', { status: 'ready' }), img('p', 1, '', { status: 'pending' }), img('b', 2)] })
    expect(screen.queryByTestId('image-p')).toBeNull()
    await userEvent.click(within(card('b')).getByRole('button', { name: /move left/i }))
    expect(api.reorderImages).toHaveBeenCalledWith(product.id, ['b', 'a'])
  })
})

describe('ImagesTab — no updates after unmount', () => {
  it('a reorder that resolves after unmount never calls onUpdated', async () => {
    const r = deferred()
    const g = deferred()
    vi.mocked(api.reorderImages).mockReturnValue(r.promise)
    vi.mocked(api.getProduct).mockReturnValue(g.promise)
    const onUpdated = vi.fn()
    const { unmount } = renderTab(withImages, onUpdated)
    await userEvent.click(within(card('b')).getByRole('button', { name: /move left/i }))
    unmount()
    await act(async () => { r.resolve({ ok: true }) })
    await act(async () => { g.resolve(withImages) })
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('a reorder whose mutation resolves after unmount does not even refetch', async () => {
    const r = deferred()
    vi.mocked(api.reorderImages).mockReturnValue(r.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    const onUpdated = vi.fn()
    const { unmount } = renderTab(withImages, onUpdated)
    await userEvent.click(within(card('b')).getByRole('button', { name: /move left/i }))
    unmount()
    await act(async () => { r.resolve({ ok: true }) })
    expect(api.getProduct).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('an upload refresh that resolves after unmount never calls onUpdated', async () => {
    const g = deferred()
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockReturnValue(g.promise)
    const onUpdated = vi.fn()
    const { unmount } = renderTab({ ...product, images: [] }, onUpdated)
    await userEvent.upload(screen.getByLabelText('Add photos'), [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => { g.resolve({ ...product, images: [confirmed] }) })
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('an alt save and a delete resolving after unmount never call onUpdated', async () => {
    const a = deferred()
    const d = deferred()
    vi.mocked(api.updateImageAlt).mockReturnValue(a.promise)
    vi.mocked(api.deleteImage).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onUpdated = vi.fn()
    const { unmount } = renderTab(withImages, onUpdated)
    await userEvent.type(within(card('b')).getByLabelText('Description'), 'x')
    await userEvent.click(within(card('b')).getByRole('button', { name: /save/i }))
    await userEvent.click(within(card('a')).getByRole('button', { name: /delete/i }))
    unmount()
    await act(async () => { a.resolve(img('b', 1, 'x')); d.resolve(null) })
    expect(onUpdated).not.toHaveBeenCalled()
  })
})

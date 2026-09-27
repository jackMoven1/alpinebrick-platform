import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
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

  it('two Save clicks in one tick send one request', async () => {
    const d = deferred()
    vi.mocked(api.updateImageAlt).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const c = card('b')
    await userEvent.type(within(c).getByLabelText('Description'), 'Side')
    const save = within(c).getByRole('button', { name: /save/i })
    act(() => { fireEvent.click(save); fireEvent.click(save) })
    expect(api.updateImageAlt).toHaveBeenCalledTimes(1)
    expect(save).toBeDisabled()
    expect(within(c).getByLabelText('Description')).toBeDisabled()
    await act(async () => { d.resolve(img('b', 1, 'Side')) })
  })

  it('two move clicks in one tick send one reorder', async () => {
    const d = deferred()
    vi.mocked(api.reorderImages).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const left = within(card('b')).getByRole('button', { name: /move left/i })
    act(() => { fireEvent.click(left); fireEvent.click(left) })
    expect(api.reorderImages).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve({ ok: true }) })
  })

  it('two Delete clicks in one tick confirm and delete once', async () => {
    const d = deferred()
    vi.mocked(api.deleteImage).mockReturnValue(d.promise)
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderTab()
    const del = within(card('b')).getByRole('button', { name: /delete/i })
    act(() => { fireEvent.click(del); fireEvent.click(del) })
    expect(api.deleteImage).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve(null) })
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

describe('ImagesTab manage - fix round 1', () => {
  it('names every photo control after its photo', () => {
    renderTab()
    // a has alt "Front"; b has none, so it is named by its place in the list.
    expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move left: Front' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move left: photo 2' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move right: photo 2' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save: Front' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save: photo 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete: Front' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete: photo 2' })).toBeInTheDocument()
    expect(within(card('b')).getByText('Delete')).toBeInTheDocument()
    expect(within(card('b')).getByText('Save')).toBeInTheDocument()
  })

  it('ties the empty-description hint to its input', () => {
    renderTab()
    expect(within(card('b')).getByLabelText('Description')).toHaveAccessibleDescription(/add a description/i)
    expect(within(card('a')).getByLabelText('Description')).not.toHaveAccessibleDescription(/add a description/i)
  })

  it('blocks moves and deletes while an upload refresh is in flight', async () => {
    const g = deferred()
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockReturnValue(g.promise)
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete: Front' })).toBeDisabled()
    await act(async () => { g.resolve(withImages) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeEnabled())
  })

  it('after a reorder whose refresh fails, moves stay blocked until a card Refresh succeeds', async () => {
    vi.mocked(api.reorderImages).mockResolvedValue({ ok: true })
    const fresh = { ...product, images: [img('b', 0), img('a', 1, 'Front')] }
    const g = deferred()
    vi.mocked(api.getProduct)
      .mockRejectedValueOnce(new AdminApiError('network hiccup', 'network_error'))
      .mockReturnValueOnce(g.promise)
    const Harness = () => {
      const [p, setP] = React.useState(withImages)
      return <ToastProvider><ImagesTab product={p} onUpdated={setP} /></ToastProvider>
    }
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Move left: photo 2' }))
    expect(await within(card('b')).findByText(/done, but the list couldn.t refresh \(network hiccup\)/i)).toBeInTheDocument()
    // The grid still shows the old order, so another move could silently undo this one.
    expect(screen.getByRole('button', { name: 'Move left: photo 2' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete: Front' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete: photo 2' })).toBeDisabled()
    await userEvent.click(within(card('b')).getByRole('button', { name: 'Refresh: photo 2' }))
    // Still blocked while that refresh is in flight.
    expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeDisabled()
    await act(async () => { g.resolve(fresh) })
    // b is now first, a second: a's left is enabled again and the error is gone.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move left: Front' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Move right: photo 1' })).toBeEnabled()
    expect(screen.queryByText(/done, but the list couldn.t refresh/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^refresh: /i })).toBeNull()
  })

  it('a deleted photo left on screen by a failed refresh cannot be deleted again', async () => {
    vi.mocked(api.deleteImage).mockResolvedValue(null)
    vi.mocked(api.getProduct).mockRejectedValue(new AdminApiError('network hiccup', 'network_error'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: 'Delete: photo 2' }))
    await within(card('b')).findByText(/done, but the list couldn.t refresh/i)
    const del = screen.getByRole('button', { name: 'Delete: photo 2' })
    expect(del).toBeDisabled()
    await userEvent.click(del)
    expect(api.deleteImage).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })
})

describe('ImagesTab manage - final review', () => {
  it('locks moves and deletes while an upload is uploading, confirming or saved but not yet in the grid', async () => {
    const put = deferred()
    const conf = deferred()
    const g = deferred()
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockReturnValue(put.promise)
    vi.mocked(api.confirmImage).mockReturnValue(conf.promise)
    vi.mocked(api.getProduct).mockReturnValue(g.promise)
    renderTab()
    const right = () => screen.getByRole('button', { name: 'Move right: Front' })
    const del = () => screen.getByRole('button', { name: 'Delete: Front' })
    expect(right()).toBeEnabled()
    await userEvent.upload(screen.getByLabelText('Add photos'), [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })])
    await waitFor(() => expect(api.uploadToStorage).toHaveBeenCalled())
    expect(right()).toBeDisabled() // uploading
    expect(del()).toBeDisabled()
    await act(async () => { put.resolve() })
    await waitFor(() => expect(api.confirmImage).toHaveBeenCalled())
    expect(right()).toBeDisabled() // confirming
    await act(async () => { conf.resolve(confirmed) })
    await waitFor(() => expect(api.getProduct).toHaveBeenCalled())
    expect(right()).toBeDisabled() // saved, refresh pending
    await act(async () => { g.resolve({ ...withImages, images: [...withImages.images, { ...confirmed, position: 2 }] }) })
    await waitFor(() => expect(right()).toBeEnabled())
  })

  it('stays locked while a saved upload is not yet in the grid, even with no refresh in flight', async () => {
    // One file saves; its sibling's PUT never finishes, so the batch never
    // refreshes. The saved photo is on core but not in the grid.
    const stuck = deferred()
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValueOnce().mockReturnValueOnce(stuck.promise)
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [
      new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array(10)], 'b.png', { type: 'image/png' }),
    ])
    await waitFor(() => expect(api.confirmImage).toHaveBeenCalledTimes(1))
    await within(screen.getByText('a.png').parentElement).findByText('Saved')
    expect(api.getProduct).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Move right: Front' })).toBeDisabled()
  })

  it.each([
    ['invalid_order', 'ordering must list every image of the product exactly once', 'reorder'],
    ['image_not_found', 'image not found', 'delete'],
  ])('a %s failure refreshes the grid so it heals', async (code, message, action) => {
    const err = new AdminApiError(message, code)
    vi.mocked(api.reorderImages).mockRejectedValue(err)
    vi.mocked(api.deleteImage).mockRejectedValue(err)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fresh = { ...product, images: [img('a', 0, 'Front')] }
    vi.mocked(api.getProduct).mockResolvedValue(fresh)
    const onUpdated = vi.fn()
    renderTab(withImages, onUpdated)
    const name = action === 'reorder' ? 'Move left: photo 2' : 'Delete: photo 2'
    await userEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(fresh))
    expect(api.getProduct).toHaveBeenCalledTimes(1)
    expect(within(card('b')).getByText(message)).toBeInTheDocument()
  })

  it('an alt save failing with image_not_found also refreshes', async () => {
    vi.mocked(api.updateImageAlt).mockRejectedValue(new AdminApiError('image not found', 'image_not_found'))
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    const onUpdated = vi.fn()
    renderTab(withImages, onUpdated)
    await userEvent.type(within(card('b')).getByLabelText('Description'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save: photo 2' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(withImages))
  })
})

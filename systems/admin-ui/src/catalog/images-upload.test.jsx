import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import { checkImageFile, MAX_IMAGE_BYTES, ACCEPTED_TYPES } from './tabs/imageFiles.js'
import product from '../data/__fixtures__/product.json'
import token from '../data/__fixtures__/image-upload-token.json'
import confirmed from '../data/__fixtures__/image-confirmed.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: {
  requestImageUpload: vi.fn(), uploadToStorage: vi.fn(), confirmImage: vi.fn(), getProduct: vi.fn(),
  reorderImages: vi.fn(), updateImageAlt: vi.fn(), deleteImage: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const png = (name, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const renderTab = (onUpdated = vi.fn()) =>
  render(<ToastProvider><ImagesTab product={{ ...product, images: [] }} onUpdated={onUpdated} /></ToastProvider>)

describe('checkImageFile', () => {
  it('accepts JPEG/PNG/WebP up to 15 MB and names the reason otherwise', () => {
    expect(checkImageFile(png('a.png'))).toBeNull()
    expect(checkImageFile(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).toMatch(/JPEG, PNG or WebP/)
    expect(checkImageFile(png('big.png', MAX_IMAGE_BYTES + 1))).toMatch(/15 MB/)
  })
})

describe('ImagesTab upload', () => {
  it('runs token → PUT → confirm per file and refreshes the product', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [confirmed] })
    const onUpdated = vi.fn()
    renderTab(onUpdated)
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ images: [confirmed] })))
    expect(api.uploadToStorage).toHaveBeenCalledWith(token.uploadUrl, expect.any(File), expect.any(Function))
    expect(api.confirmImage).toHaveBeenCalledWith(token.imageId)
  })

  it('never sends a file that fails the client check', async () => {
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [new File(['x'], 'logo.svg', { type: 'image/svg+xml' })], { applyAccept: false })
    expect(await screen.findByText(/logo\.svg/)).toBeInTheDocument()
    expect(api.requestImageUpload).not.toHaveBeenCalled()
  })

  it('one failing file shows core\'s message and Retry; the others finish', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage)
      .mockRejectedValueOnce(new AdminApiError('the uploaded file does not match what was declared; please upload it again', 'upload_mismatch'))
      .mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [confirmed] })
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('bad.png'), png('good.png')])
    expect(await screen.findByText(/does not match what was declared/)).toBeInTheDocument()
    expect(api.confirmImage).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: /retry bad\.png/i }))
    await waitFor(() => expect(api.requestImageUpload).toHaveBeenCalledTimes(3))
  })
})

describe('ImagesTab upload — fix round 1', () => {
  it('draws the progress bar from a fractional onProgress as a percentage', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    let captured
    vi.mocked(api.uploadToStorage).mockImplementation((url, file, onProgress) => {
      captured = onProgress
      return new Promise(() => {}) // stay in 'uploading' so the bar is visible
    })
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    await waitFor(() => expect(captured).toBeInstanceOf(Function))
    act(() => captured(0.5))
    const bar = document.querySelector('.bg-brand')
    expect(bar).toHaveStyle({ width: '50%' })
  })

  it('a refresh failure after a successful confirm offers Refresh, not Retry, and never re-uploads', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct)
      .mockRejectedValueOnce(new AdminApiError('network hiccup', 'network_error'))
      .mockResolvedValue({ ...product, images: [confirmed] })
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    expect(await screen.findByText(/photo saved, but the list couldn.t refresh/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry a\.png/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(2))
    expect(api.requestImageUpload).toHaveBeenCalledTimes(1)
  })

  it('refreshes once after the whole batch settles, including both photos regardless of confirm order', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    let resolveFirst
    vi.mocked(api.confirmImage)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = () => resolve(confirmed) }))
      .mockResolvedValueOnce({ ...confirmed, id: 'img2' })
    const secondImage = { ...confirmed, id: 'img2' }
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [confirmed, secondImage] })
    const onUpdated = vi.fn()
    renderTab(onUpdated)
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('one.png'), png('two.png')])
    await waitFor(() => expect(api.confirmImage).toHaveBeenCalledTimes(2))
    await act(async () => { resolveFirst() })
    await waitFor(() => expect(api.getProduct).toHaveBeenCalled())
    // Give any second, out-of-order refresh call a chance to land before asserting the count is exact.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(api.getProduct).toHaveBeenCalledTimes(1)
    expect(onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ images: [confirmed, secondImage] }))
  })

  it('shows plain-English stage labels and a comma-joined accept list', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockImplementation(() => new Promise(() => {}))
    renderTab()
    const input = screen.getByLabelText('Add photos')
    expect(input).toHaveAttribute('accept', ACCEPTED_TYPES.join(','))
    await userEvent.upload(input, [png('a.png')])
    expect(await screen.findByText('Uploading…')).toBeInTheDocument()
  })
})

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
    let releaseUpload, rejectConfirm
    vi.mocked(api.uploadToStorage).mockImplementation(() => new Promise((resolve) => { releaseUpload = resolve }))
    vi.mocked(api.confirmImage).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectConfirm = () => reject(new AdminApiError('nope', 'bad')) }),
    )
    renderTab()
    const input = screen.getByLabelText('Add photos')
    expect(input).toHaveAttribute('accept', ACCEPTED_TYPES.join(','))
    await userEvent.upload(input, [png('a.png')])
    expect(await screen.findByText('Uploading…')).toBeInTheDocument()
    await act(async () => { releaseUpload() })
    expect(await screen.findByText('Checking…')).toBeInTheDocument()
    await act(async () => { rejectConfirm() })
    expect(await screen.findByText('Failed')).toBeInTheDocument()
  })

  it('shows "Saved" once confirm succeeds', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockImplementation(() => new Promise(() => {})) // keep the row visible as 'saved'
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})

describe('ImagesTab upload — fix round 2 (refresh race)', () => {
  it('ignores a stale getProduct response when a later-issued refresh already resolved', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    const secondImage = { ...confirmed, id: 'img2' }
    let resolveFirstRefresh, resolveSecondRefresh
    vi.mocked(api.getProduct)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstRefresh = () => resolve({ ...product, images: [confirmed] }) }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondRefresh = () => resolve({ ...product, images: [confirmed, secondImage] }) }))
    const onUpdated = vi.fn()
    renderTab(onUpdated)

    // First upload's batch issues refresh #1, held pending.
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('one.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1))

    // Second upload's batch issues refresh #2 while #1 is still in flight.
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('two.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(2))

    // The later-issued refresh (#2) resolves first, with both photos.
    await act(async () => { resolveSecondRefresh() })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ images: [confirmed, secondImage] })))

    // The stale, earlier-issued refresh (#1) resolves last — it must be ignored.
    await act(async () => { resolveFirstRefresh() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ images: [confirmed, secondImage] }))
  })

  it('a row saved while an earlier refresh is in flight stays "Saved" once that refresh resolves', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    let resolveFirstRefresh
    vi.mocked(api.getProduct)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstRefresh = () => resolve({ ...product, images: [confirmed] }) }))
      .mockImplementationOnce(() => new Promise(() => {})) // refresh #2 stays pending for this test

    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('one.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1)) // refresh #1 issued, pending

    await userEvent.upload(screen.getByLabelText('Add photos'), [png('two.png')])
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBe(2)) // both rows saved
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(2)) // refresh #2 issued (snapshot includes both)

    // Refresh #1 (issued before two.png was saved) resolves now — it's stale, so nothing is cleared.
    await act(async () => { resolveFirstRefresh() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getAllByText('Saved').length).toBe(2)
  })

  it('disables Refresh while a refresh is in flight', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    let resolveRefresh
    vi.mocked(api.getProduct)
      .mockRejectedValueOnce(new AdminApiError('network hiccup', 'network_error'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = () => resolve({ ...product, images: [confirmed] }) }))
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    const refreshBtn = await screen.findByRole('button', { name: /^refresh$/i })
    await userEvent.click(refreshBtn)
    expect(refreshBtn).toBeDisabled()
    await act(async () => { resolveRefresh() })
    await waitFor(() => expect(refreshBtn).not.toBeInTheDocument())
  })
})

describe('ImagesTab upload — fix round 3 (snapshot isolation)', () => {
  // Round 2's "row saved while an earlier refresh is in flight" test also
  // passes with only the seq guard and no id snapshot, because that refresh
  // ends up stale by the time it resolves (a newer one was issued first).
  // This test keeps a single refresh in flight — never superseded, so the
  // seq guard alone would let it through — and checks that its own success
  // handler still only clears the ids it snapshotted, not a row that saved
  // afterward. Only the idsAtIssue filter protects this case.
  it('a row that saves after the only in-flight refresh was issued is not cleared by that refresh succeeding', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockImplementation((url, file) => (
      file.name === 'b.png' ? new Promise(() => {}) : Promise.resolve()
    ))
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    let resolveRefresh
    vi.mocked(api.getProduct).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = () => resolve({ ...product, images: [confirmed] }) }),
    )
    renderTab()

    // x.png uploads alone; its batch issues the only refresh, held pending.
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('x.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1))

    // a.png + b.png upload together; a.png saves, b.png's PUT never resolves,
    // so this batch's own Promise.allSettled never settles and it never
    // issues a second refresh — the refresh above stays the only one.
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png'), png('b.png')])
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBe(2)) // x.png + a.png

    // The only refresh in flight succeeds. It is not stale (nothing newer
    // was ever issued) — without the snapshot filter this would clear every
    // 'saved' row, including a.png, which saved after this refresh was issued.
    await act(async () => { resolveRefresh() })
    await waitFor(() => expect(screen.queryByText('x.png')).not.toBeInTheDocument())
    expect(screen.getByText('a.png')).toBeInTheDocument()
    expect(screen.getAllByText('Saved').length).toBe(1)
  })

  it('an older refresh failing after a newer one already succeeded does not flip any row to refresh-error', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    const secondImage = { ...confirmed, id: 'img2' }
    let rejectFirstRefresh, resolveSecondRefresh
    vi.mocked(api.getProduct)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirstRefresh = () => reject(new AdminApiError('network hiccup', 'network_error')) }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondRefresh = () => resolve({ ...product, images: [confirmed, secondImage] }) }))
    renderTab()

    await userEvent.upload(screen.getByLabelText('Add photos'), [png('one.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(1)) // refresh #1 issued, pending, will fail

    await userEvent.upload(screen.getByLabelText('Add photos'), [png('two.png')])
    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(2)) // refresh #2 issued, pending, will succeed

    // Newer refresh (#2) succeeds first.
    await act(async () => { resolveSecondRefresh() })
    await waitFor(() => expect(screen.queryByText('one.png')).not.toBeInTheDocument())
    expect(screen.queryByText('two.png')).not.toBeInTheDocument()

    // Older refresh (#1) fails afterward — it's stale, so it must not
    // resurrect a refresh-error row or a Refresh button for anything.
    await act(async () => { rejectFirstRefresh() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByRole('button', { name: /^refresh$/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/photo saved, but the list couldn.t refresh/i)).not.toBeInTheDocument()
  })
})

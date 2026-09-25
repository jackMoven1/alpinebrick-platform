import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import { previewSplit } from './tabs/StockDialog.jsx'
import withStock from '../data/__fixtures__/product-with-stock.json'
import stockChanged from '../data/__fixtures__/stock-changed.json'
import history from '../data/__fixtures__/stock-history.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: {
  createVariant: vi.fn(), bulkCreateVariants: vi.fn(), updateVariant: vi.fn(),
  deleteVariant: vi.fn(), setStock: vi.fn(), getStockHistory: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const v = withStock.variants[0]
const renderTab = (p = withStock, onUpdated = vi.fn()) =>
  render(<ToastProvider><VariantsTab product={p} onUpdated={onUpdated} /></ToastProvider>)

const UNLISTED = /isn.t listed on walmart/i

describe('previewSplit', () => {
  it('matches core for shared and split stock', () => {
    expect(previewSplit(5, 2, null)).toEqual({ storefront: 3, walmart: 3, shared: true })
    expect(previewSplit(1, 0, 1)).toEqual({ storefront: 0, walmart: 1, shared: false })
  })
})

describe('VariantsTab', () => {
  it('shows stock per channel from core', () => {
    renderTab()
    const row = screen.getByRole('row', { name: new RegExp(v.sku) })
    expect(within(row).getByText(String(v.inventory.onHand))).toBeInTheDocument()
    expect(within(row).getByText(`Walmart ${v.inventory.walmartAllocation}`)).toBeInTheDocument()
  })

  it('adds a variant, converting dollars to cents once', async () => {
    vi.mocked(api.createVariant).mockResolvedValue(withStock)
    renderTab({ ...withStock, variants: [] })
    await userEvent.type(screen.getByPlaceholderText('SKU'), 'abe-2')
    await userEvent.type(screen.getByPlaceholderText('Price $'), '19.99')
    await userEvent.type(screen.getByPlaceholderText('Qty'), '2')
    await userEvent.click(screen.getByRole('button', { name: /add variant/i }))
    expect(api.createVariant).toHaveBeenCalledWith(withStock.id, { sku: 'abe-2', priceCents: 1999, onHand: 2 })
  })

  it('bulk-creates core rows with cents and attributes', async () => {
    vi.mocked(api.bulkCreateVariants).mockResolvedValue(withStock)
    renderTab({ ...withStock, variants: [] })
    await userEvent.type(screen.getByPlaceholderText('SKU prefix'), 'T-')
    await userEvent.type(screen.getByPlaceholderText('Price each $'), '0.29')
    await userEvent.type(screen.getByPlaceholderText('Values: S,M,L'), 's,m')
    await userEvent.click(screen.getByRole('button', { name: /create 2 variant/i }))
    expect(api.bulkCreateVariants).toHaveBeenCalledWith(withStock.id, [
      { sku: 'T-S', priceCents: 29, attributes: { size: 's' } },
      { sku: 'T-M', priceCents: 29, attributes: { size: 'm' } },
    ])
  })

  it('saves an edited price as a cents patch', async () => {
    vi.mocked(api.updateVariant).mockResolvedValue(withStock)
    renderTab()
    const price = screen.getByLabelText(`Price ${v.sku}`)
    await userEvent.clear(price); await userEvent.type(price, '12.50')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(api.updateVariant).toHaveBeenCalledWith(v.id, { priceCents: 1250 })
  })

  it('renders SKU and delete as locked with a reason', () => {
    renderTab({ ...withStock, variants: [{ ...v, locked: { sku: true, delete: true } }] })
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled()
    expect(screen.getAllByTitle(/sold or listed on walmart/i).length).toBeGreaterThan(0)
  })

  it('sets stock and allocation from the dialog', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue(history)
    vi.mocked(api.setStock).mockResolvedValue(withStock)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    const onHand = screen.getByLabelText('On hand')
    await userEvent.clear(onHand); await userEvent.type(onHand, '4')
    await userEvent.click(screen.getByLabelText(/split/i))
    const alloc = screen.getByLabelText('Walmart allocation')
    await userEvent.clear(alloc); await userEvent.type(alloc, '1')
    await userEvent.click(screen.getByRole('button', { name: /save stock/i }))
    expect(api.setStock).toHaveBeenCalledWith(v.id, expect.objectContaining({
      onHand: 4, walmartAllocation: 1, expectedOnHand: v.inventory.onHand,
    }))
  })

  it('shows recent stock history in the dialog', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue(history)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    expect(await screen.findByText(/one for Walmart/)).toBeInTheDocument()
    expect(api.getStockHistory).toHaveBeenCalledWith(v.id)
  })

  it('warns about double sales when choosing shared, and previews both channels selling everything', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    await userEvent.click(screen.getByLabelText(/shared/i))
    expect(screen.getByText(/can sell twice/i)).toBeInTheDocument()
    const free = v.inventory.onHand - v.inventory.reserved
    expect(screen.getByText(/storefront can sell/i)).toHaveTextContent(`Storefront can sell ${free} · Walmart can sell ${free}`)
  })

  it('warns when units are allocated to a variant not listed on Walmart', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    renderTab() // the fixture predates walmartListing: missing is treated as null
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    expect(screen.getByText(UNLISTED)).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/shared/i))
    expect(screen.queryByText(UNLISTED)).not.toBeInTheDocument()
  })

  it('warns for a retired listing but not a live one', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    const { unmount } = renderTab({ ...withStock, variants: [{ ...v, walmartListing: { status: 'live' } }] })
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    expect(screen.queryByText(UNLISTED)).not.toBeInTheDocument()
    unmount()
    renderTab({ ...withStock, variants: [{ ...v, walmartListing: { status: 'retired' } }] })
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    expect(screen.getByText(UNLISTED)).toBeInTheDocument()
  })

  it('offers to overwrite when stock changed underneath, retrying against the new value', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    // 5, not the fixture's 3: the variant was opened at 3, so a retry that
    // resent the original expectation would be indistinguishable from 3.
    const details = { ...stockChanged.details, onHand: 5 }
    vi.mocked(api.setStock)
      .mockRejectedValueOnce(new AdminApiError('stock changed to 5 since you opened this', stockChanged.code, undefined, details))
      .mockResolvedValueOnce(withStock)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    await userEvent.click(screen.getByRole('button', { name: /save stock/i }))
    const confirm = await screen.findByRole('button', { name: /set it anyway/i })
    expect(screen.getByText(/stock changed to/i)).toHaveTextContent('Stock changed to 5 since you opened this')
    await userEvent.click(confirm)
    expect(vi.mocked(api.setStock).mock.calls[0][1].expectedOnHand).toBe(v.inventory.onHand)
    expect(vi.mocked(api.setStock).mock.calls[1][1].expectedOnHand).toBe(5)
  })

  it.each([
    ['STOCK_BELOW_RESERVED', 'on hand cannot go below the 2 reserved by open orders', { onHand: 'at least 2' }],
    ['ALLOCATION_EXCEEDS_AVAILABLE', 'reserved (0) plus Walmart allocation (4) cannot exceed on hand (3); lower the allocation too', { walmartAllocation: 'at most 3' }],
  ])("shows core's full message for %s, not just the field hint", async (code, message, fields) => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    vi.mocked(api.setStock).mockRejectedValueOnce(new AdminApiError(message, code, fields, { onHand: 3, reserved: 0, walmartAllocation: 1 }))
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    await userEvent.click(screen.getByRole('button', { name: /save stock/i }))
    expect(await screen.findByText(message, { exact: false })).toBeInTheDocument()
  })

  it('shows attributes read-only as key: value', () => {
    renderTab()
    const row = screen.getByRole('row', { name: new RegExp(v.sku) })
    expect(within(row).getByText('condition: sealed')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Attributes' })).toBeInTheDocument()
  })

  it('shows a dash for a variant without attributes', () => {
    renderTab({ ...withStock, variants: [{ ...v, attributes: {} }] })
    const row = screen.getByRole('row', { name: new RegExp(v.sku) })
    expect(within(row).getByText('—')).toBeInTheDocument()
  })
})

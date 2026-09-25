import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import PublishTab from './tabs/PublishTab.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import InfoTab from './tabs/InfoTab.jsx'

vi.mock('../data/api.js', () => ({
  default: { setProductStatus: vi.fn(async () => ({ id: 'p1', status: 'published' })) },
}))
import api from '../data/api.js'

const product = {
  id: 'p1', name: 'P', slug: 'p', description: 'd', status: 'draft',
  categories: ['starter'],
  variants: [{
    id: 'v1', sku: 'S', priceCents: 100, currency: 'USD', attributes: {},
    inventory: { onHand: 1, reserved: 0, walmartAllocation: null, storefrontAvailable: 1, walmartAvailable: 1 },
    locked: { sku: false, delete: false }, walmartListing: null,
  }],
  images: [{ storageKey: 'products/p1/i1/original.jpg', alt: 'Front', width: 900, height: 720, position: 0 }],
}

afterEach(() => vi.clearAllMocks())

const wrap = (ui) => render(
  <ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider>,
)

describe('PublishTab — the live path', () => {
  it('publishes through the real api', async () => {
    wrap(<PublishTab product={product} onUpdated={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    expect(api.setProductStatus).toHaveBeenCalledWith('p1', 'published')
  })
})

// VariantsTab used to sit in the "unbacked" block below. Task 13 backed it
// with core's variant and stock endpoints, so it now asserts the live tab.
describe('VariantsTab — live since task 13', () => {
  it('offers enabled per-variant controls and no read-only notice', () => {
    wrap(<VariantsTab product={product} onUpdated={() => {}} />)
    expect(screen.queryByText(/not in this phase/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set stock' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })
})

// Unbacked features must be visibly unavailable BEFORE effort is invested,
// not throw after a form is filled in.
describe('unbacked tabs are disabled', () => {

  it('ImagesTab explains it is unavailable and offers no enabled control', () => {
    wrap(<ImagesTab product={product} />)
    expect(screen.getByText(/not in this phase/i)).toBeInTheDocument()
    for (const b of screen.queryAllByRole('button')) expect(b).toBeDisabled()
  })

  it('InfoTab requires an explicit edit before Save changes is enabled', () => {
    wrap(<InfoTab product={product} onUpdated={() => {}} />)
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
  })

  // Images arrive as keys; the console must resolve them, not render the key.
  it('ImagesTab resolves a storage key into an image src', () => {
    wrap(<ImagesTab product={product} />)
    expect(screen.getByAltText('Front'))
      .toHaveAttribute('src', expect.stringContaining('products/p1/i1/original.jpg'))
  })
})

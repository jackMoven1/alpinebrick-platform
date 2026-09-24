import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CatalogOverview from './CatalogOverview.jsx'

// Stubbed with core's real /overview shape, NOT mockApi's. Core deliberately
// omits `missingImages` (phase B spec section 7); the console read it
// unconditionally and blanked the whole app on the first screen after sign-in
// on staging, while every test here passed against the mock.
vi.mock('../data/api.js', () => ({ default: { getOverviewStats: vi.fn() } }))
import api from '../data/api.js'

const CORE_OVERVIEW = {
  totalProducts: 1, published: 0, draft: 1, archived: 0,
  recentlyModified: [{ id: 'p1', slug: 'a', name: 'Alpha', status: 'draft', categories: [], variantCount: 0, imageCount: 0 }],
  missingVariants: [{ id: 'p1', slug: 'a', name: 'Alpha', status: 'draft', categories: [], variantCount: 0, imageCount: 0 }],
}

afterEach(() => vi.clearAllMocks())

describe('CatalogOverview', () => {
  it('renders core\'s overview, which has no missingImages field', async () => {
    vi.mocked(api.getOverviewStats).mockResolvedValue(CORE_OVERVIEW)
    render(<MemoryRouter><CatalogOverview /></MemoryRouter>)
    expect(await screen.findByText('Missing variants')).toBeInTheDocument()
    expect(screen.getByText('Total products')).toBeInTheDocument()
  })

  it('omits the Missing images panel rather than showing it empty', async () => {
    vi.mocked(api.getOverviewStats).mockResolvedValue(CORE_OVERVIEW)
    render(<MemoryRouter><CatalogOverview /></MemoryRouter>)
    await screen.findByText('Missing variants')
    // An empty panel reads as "all clear"; spec section 7 says absent instead.
    expect(screen.queryByText('Missing images')).not.toBeInTheDocument()
  })
})

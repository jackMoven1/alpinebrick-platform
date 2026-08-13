import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, MemoryRouter } from 'react-router'
import type { Product, ProductListPage } from '../lib/api/types'
import { CartProvider } from '../lib/cart/CartContext'

vi.mock('../lib/api/catalog', () => ({
  getProducts: vi.fn(),
  getProduct: vi.fn(),
  getAvailability: vi.fn(),
}))
import { getProducts, getProduct, getAvailability } from '../lib/api/catalog'

import Home, { homeLoader } from './Home'
import Collections from './Collections'
import CollectionDetail, { collectionLoader } from './CollectionDetail'
import ProductDetail, { productLoader } from './ProductDetail'
import { COLLECTIONS } from '../lib/collections'

/**
 * Loaders are tested as the plain async functions they are, with a minimal
 * fake request. Components are rendered through a router pre-seeded with
 * `hydrationData` so no loader runs during the render.
 *
 * This is deliberate: letting React Router construct a real Request under jsdom
 * fails with "Expected signal to be an instance of AbortSignal" — jsdom's
 * AbortSignal is not Node's, and undici rejects it. Separating loader logic
 * from render logic avoids the mismatch and tests each more directly.
 */
function fakeRequest(url: string) {
  return { request: { url } } as never
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', slug: 'dragon-fortress', name: 'Dragon Fortress',
    description: 'Ancient stone walls.', productType: 'resale',
    releaseType: 'limited_run', status: 'published',
    images: [
      { storageKey: 'products/p1/a/original.jpg', alt: 'Dragon Fortress front', width: 1600, height: 1200, position: 0 },
      { storageKey: 'products/p1/b/original.jpg', alt: 'Dragon Fortress rear', width: 1600, height: 1200, position: 1 },
    ],
    categories: ['fantasy'], pieces: 3156, difficulty: 'advanced',
    ageRecommendation: '14+', dimensions: '40 x 30 cm',
    longDescription: 'A long description of the fortress.',
    features: ['Seven secret passages'], includes: ['4 minifigures'],
    builderNotes: 'The gatehouse was rebuilt twice.',
    homePosition: 1, collectionPosition: 1,
    createdAt: '2020-01-01T00:00:00Z',
    variants: [{ id: 'v1', sku: 'DF-1', priceCents: 24900, currency: 'USD' }],
    ...over,
  }
}

function listPage(items: Product[], over: Partial<ProductListPage> = {}): ProductListPage {
  return { items, total: items.length, page: 1, pageSize: 24, totalPages: 1, ...over }
}

/** Render a component with loader data already supplied. */
function renderWithData(Component: React.ComponentType, data: unknown, wrap = false) {
  const router = createMemoryRouter([{ id: 'route', path: '/', Component }], {
    initialEntries: ['/'],
    hydrationData: { loaderData: { route: data } },
  })
  const tree = <RouterProvider router={router} />
  return render(wrap ? <CartProvider>{tree}</CartProvider> : tree)
}

afterEach(() => vi.clearAllMocks())

// ------------------------------------------------------------ homeLoader

describe('homeLoader', () => {
  it('requests the merchandised home display order', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await homeLoader(fakeRequest('http://localhost/'))
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ sort: 'home_display' })
  })

  it('passes the category query parameter through to the API', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await homeLoader(fakeRequest('http://localhost/?category=space'))
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ category: 'space' })
  })

  it('passes the q query parameter through as search', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await homeLoader(fakeRequest('http://localhost/?q=dragon'))
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ search: 'dragon' })
  })

  it('sends no category or search when none were supplied', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await homeLoader(fakeRequest('http://localhost/'))
    // getProducts declares `opts` with a default, so the recorded arg is
    // optional to TypeScript even though the loader always passes one.
    const arg = vi.mocked(getProducts).mock.calls[0]![0]!
    expect(arg.category).toBeUndefined()
    expect(arg.search).toBeUndefined()
  })
})

// ------------------------------------------------------------------ Home

describe('Home', () => {
  it('renders the products the loader fetched', () => {
    renderWithData(Home, { page: listPage([product({ name: 'Orbiter' })]), category: null, search: null })
    expect(screen.getByText('Orbiter')).toBeInTheDocument()
  })

  it('shows an empty state rather than a blank page', () => {
    renderWithData(Home, { page: listPage([]), category: null, search: null })
    expect(screen.getByText(/no sets in this category yet/i)).toBeInTheDocument()
  })

  // The server decides the order. If the page re-sorts, page 2 would be sorted
  // independently of page 1 and the sequence breaks.
  it('renders products in the exact order the API returned them', () => {
    const items = [
      product({ id: '1', slug: 'zulu', name: 'Zulu Set' }),
      product({ id: '2', slug: 'alpha', name: 'Alpha Set' }),
      product({ id: '3', slug: 'mike', name: 'Mike Set' }),
    ]
    renderWithData(Home, { page: listPage(items), category: null, search: null })
    const names = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(names).toEqual(['Zulu Set', 'Alpha Set', 'Mike Set'])
  })

  it('offers a filter link for every theme collection', () => {
    renderWithData(Home, { page: listPage([]), category: null, search: null })
    for (const slug of ['architecture', 'fantasy', 'space', 'ocean', 'nature']) {
      expect(screen.getByRole('link', { name: new RegExp(slug, 'i') })).toHaveAttribute(
        'href',
        `/?category=${slug}`,
      )
    }
  })

  it('marks the active category filter for assistive tech', () => {
    renderWithData(Home, { page: listPage([]), category: 'space', search: null })
    expect(screen.getByRole('link', { name: /space/i })).toHaveAttribute('aria-current', 'page')
  })

  it('reports the result count when a search was made', () => {
    renderWithData(Home, {
      page: listPage([product()], { total: 1 }),
      category: null,
      search: 'dragon',
    })
    expect(screen.getByText(/1 result for/i)).toBeInTheDocument()
  })
})

// ----------------------------------------------------- collectionLoader

describe('collectionLoader', () => {
  it('queries with the collection query in collection display order', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await collectionLoader({ params: { slug: 'space' } } as never)
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({
      category: 'space',
      sort: 'collection_display',
    })
  })

  it('never requests the home display order', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await collectionLoader({ params: { slug: 'fantasy' } } as never)
    expect(vi.mocked(getProducts).mock.calls[0]![0]!.sort).not.toBe('home_display')
  })

  it('resolves new-arrivals chronologically rather than by display order', async () => {
    vi.mocked(getProducts).mockResolvedValue(listPage([]))
    await collectionLoader({ params: { slug: 'new-arrivals' } } as never)
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ sort: 'newest' })
  })

  // An empty grid would claim the collection exists but is empty.
  it('throws a 404 for an unknown slug without calling the API', async () => {
    await expect(collectionLoader({ params: { slug: 'not-a-collection' } } as never)).rejects.toMatchObject({
      status: 404,
    })
    expect(getProducts).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------- Collections

describe('Collections index', () => {
  it('lists every collection with a link to its detail page', () => {
    render(<MemoryRouter><Collections /></MemoryRouter>)
    for (const c of COLLECTIONS) {
      expect(screen.getByRole('link', { name: new RegExp(c.title, 'i') })).toHaveAttribute(
        'href',
        `/collections/${c.slug}`,
      )
    }
  })

  it('shows each collection blurb', () => {
    render(<MemoryRouter><Collections /></MemoryRouter>)
    for (const c of COLLECTIONS) expect(screen.getByText(c.blurb)).toBeInTheDocument()
  })
})

describe('CollectionDetail', () => {
  it('renders the collection title and blurb', () => {
    const collection = COLLECTIONS[0]
    renderWithData(CollectionDetail, { collection, page: listPage([]) })
    expect(screen.getByRole('heading', { level: 1, name: new RegExp(collection.title, 'i') }))
      .toBeInTheDocument()
    expect(screen.getByText(collection.blurb)).toBeInTheDocument()
  })

  it('renders the collection products', () => {
    renderWithData(CollectionDetail, {
      collection: COLLECTIONS[0],
      page: listPage([product({ name: 'Skyline' })]),
    })
    expect(screen.getByText('Skyline')).toBeInTheDocument()
  })
})

// -------------------------------------------------------- productLoader

describe('productLoader', () => {
  it('fetches the product and its availability', async () => {
    vi.mocked(getProduct).mockResolvedValue(product())
    vi.mocked(getAvailability).mockResolvedValue([{ variantId: 'v1', sku: 'DF-1', available: 5 }])
    const data = await productLoader({ params: { id: 'dragon-fortress' } } as never)
    expect(data.product.slug).toBe('dragon-fortress')
    expect(data.availability).toHaveLength(1)
  })

  // An availability outage must not take the product page down with it.
  it('falls back to empty availability when the stock call fails', async () => {
    vi.mocked(getProduct).mockResolvedValue(product())
    vi.mocked(getAvailability).mockRejectedValue(new Error('stock service down'))
    const data = await productLoader({ params: { id: 'dragon-fortress' } } as never)
    expect(data.availability).toEqual([])
    expect(data.product.name).toBe('Dragon Fortress')
  })
})

// ------------------------------------------------------- ProductDetail

function renderProduct(availability = [{ variantId: 'v1', sku: 'DF-1', available: 5 }]) {
  return renderWithData(ProductDetail, { product: product(), availability }, true)
}

describe('ProductDetail', () => {
  it('renders name, price and specifications', () => {
    renderProduct()
    expect(screen.getByRole('heading', { level: 1, name: 'Dragon Fortress' })).toBeInTheDocument()
    expect(screen.getByText('$249.00')).toBeInTheDocument()
    expect(screen.getByText('3,156')).toBeInTheDocument()
    expect(screen.getByText('14+')).toBeInTheDocument()
  })

  it('shows the primary image with its alt text', () => {
    renderProduct()
    expect(screen.getByAltText('Dragon Fortress front')).toBeInTheDocument()
  })

  it('shows the Limited badge for a limited run', () => {
    renderProduct()
    expect(screen.getByText('Limited')).toBeInTheDocument()
  })

  it('adds to cart and confirms', async () => {
    renderProduct()
    await userEvent.click(screen.getByRole('button', { name: /add to cart/i }))
    expect(await screen.findByText(/added/i)).toBeInTheDocument()
  })

  it('disables add to cart when the variant is explicitly out of stock', () => {
    renderProduct([{ variantId: 'v1', sku: 'DF-1', available: 0 }])
    expect(screen.getByRole('button', { name: /out of stock/i })).toBeDisabled()
  })

  // Unknown availability is not the same as zero. A missing row must not block
  // a sale, or an availability outage silently closes the shop.
  it('still allows adding when availability is unknown', () => {
    renderProduct([])
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeEnabled()
  })

  it('exposes description and specification tabs', () => {
    renderProduct()
    expect(screen.getByRole('tab', { name: /description/i })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(2)
  })

  it('switches the gallery image from a thumbnail', async () => {
    renderProduct()
    await userEvent.click(screen.getByRole('button', { name: /view dragon fortress rear/i }))
    expect(screen.getByAltText('Dragon Fortress rear')).toBeInTheDocument()
  })

  it('renders no rating or review count', () => {
    renderProduct()
    expect(screen.queryByText(/review/i)).not.toBeInTheDocument()
  })
})

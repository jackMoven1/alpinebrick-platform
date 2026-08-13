import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ProductCard } from './ProductCard'
import { ProductGrid } from './ProductGrid'
import type { Product } from '../lib/api/types'

function make(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', slug: 'dragon-fortress', name: 'Dragon Fortress',
    description: 'Ancient stone walls.', productType: 'resale',
    releaseType: 'standard', status: 'published',
    images: [{
      storageKey: 'products/p1/i1/original.jpg', alt: 'Dragon Fortress front view',
      width: 900, height: 720, position: 0,
    }],
    categories: ['fantasy'], pieces: 3156, difficulty: 'advanced',
    ageRecommendation: '14+', dimensions: '40 x 30 cm', longDescription: '',
    features: [], includes: [], builderNotes: '',
    homePosition: 1, collectionPosition: 1,
    createdAt: '2020-01-01T00:00:00Z',
    variants: [{ id: 'v1', sku: 'DF-1', priceCents: 24900, currency: 'USD' }],
    ...over,
  }
}

const wrap = (p: Product) => render(<MemoryRouter><ProductCard product={p} /></MemoryRouter>)

describe('ProductCard', () => {
  it('shows the name, formatted price and piece count', () => {
    wrap(make())
    expect(screen.getByText('Dragon Fortress')).toBeInTheDocument()
    expect(screen.getByText('$249.00')).toBeInTheDocument()
    expect(screen.getByText(/3,156 pieces/)).toBeInTheDocument()
  })

  it('links to the product detail route by slug', () => {
    wrap(make())
    expect(screen.getByRole('link')).toHaveAttribute('href', '/product/dragon-fortress')
  })

  it('uses the image alt text supplied by the API', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view')).toBeInTheDocument()
  })

  it('resolves the src from the storage key', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view'))
      .toHaveAttribute('src', expect.stringContaining('products/p1/i1/original.jpg'))
  })

  // Without intrinsic dimensions every card reflows as images load.
  it('reserves layout space with width and height attributes', () => {
    wrap(make())
    const img = screen.getByAltText('Dragon Fortress front view')
    expect(img).toHaveAttribute('width', '900')
    expect(img).toHaveAttribute('height', '720')
  })

  it('emits a srcset so the browser can pick a size', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view')).toHaveAttribute('srcset')
  })

  it('renders the Limited badge for a limited run', () => {
    wrap(make({ releaseType: 'limited_run' }))
    expect(screen.getByText('Limited')).toBeInTheDocument()
  })

  it('renders no badge for an older standard product', () => {
    wrap(make())
    expect(screen.queryByText('Limited')).not.toBeInTheDocument()
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('omits the piece count rather than printing null', () => {
    wrap(make({ pieces: null }))
    expect(screen.queryByText(/pieces/)).not.toBeInTheDocument()
  })

  it('survives a product with no images', () => {
    wrap(make({ images: [] }))
    expect(screen.getByText('Dragon Fortress')).toBeInTheDocument()
  })

  it('shows no price when the product has no variants', () => {
    wrap(make({ variants: [] }))
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  // Never invent review data.
  it('renders no rating or review count', () => {
    wrap(make())
    expect(screen.queryByText(/review/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/★|stars?/i)).not.toBeInTheDocument()
  })
})

describe('ProductGrid', () => {
  it('shows an empty state rather than a blank region', () => {
    render(<MemoryRouter><ProductGrid products={[]} /></MemoryRouter>)
    expect(screen.getByText(/no sets here yet/i)).toBeInTheDocument()
  })

  it('accepts a caller-supplied empty message', () => {
    render(<MemoryRouter><ProductGrid products={[]} emptyMessage="Nothing in this collection" /></MemoryRouter>)
    expect(screen.getByText('Nothing in this collection')).toBeInTheDocument()
  })

  // The server owns merchandised order; the grid must not re-sort.
  it('renders products in the exact order given', () => {
    const products = [
      make({ id: '1', slug: 'zulu', name: 'Zulu Set' }),
      make({ id: '2', slug: 'alpha', name: 'Alpha Set' }),
      make({ id: '3', slug: 'mike', name: 'Mike Set' }),
    ]
    render(<MemoryRouter><ProductGrid products={products} /></MemoryRouter>)
    const names = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(names).toEqual(['Zulu Set', 'Alpha Set', 'Mike Set'])
  })
})

import type { GetProductsOptions } from './api/catalog'

export interface Collection {
  slug: string
  title: string
  blurb: string
  query: GetProductsOptions
}

/**
 * Collections are saved queries, not a database table.
 *
 * Every curated collection sorts by collection_display so merchandised order is
 * decided server-side and the storefront renders what it receives. new-arrivals
 * is the one exception: "recently added" is intrinsically chronological, and
 * hand-ranking it would mean re-merchandising on every new product.
 *
 * limited-edition resolves through a CATEGORY, not a releaseType filter — core
 * has no releaseType parameter, and the seed gives every limited run the
 * 'limited-edition' category.
 */
export const COLLECTIONS: Collection[] = [
  {
    slug: 'architecture',
    title: 'Architecture',
    blurb: 'Skylines, landmarks and structures built brick by brick.',
    query: { category: 'architecture', sort: 'collection_display' },
  },
  {
    slug: 'fantasy',
    title: 'Fantasy',
    blurb: 'Castles, dragons and the worlds that hold them.',
    query: { category: 'fantasy', sort: 'collection_display' },
  },
  {
    slug: 'space',
    title: 'Space',
    blurb: 'Orbiters, landers and deep-space exploration builds.',
    query: { category: 'space', sort: 'collection_display' },
  },
  {
    slug: 'ocean',
    title: 'Ocean',
    blurb: 'Submersibles, reefs and everything beneath the surface.',
    query: { category: 'ocean', sort: 'collection_display' },
  },
  {
    slug: 'nature',
    title: 'Nature',
    blurb: 'Botanicals, landscapes and wildlife in brick form.',
    query: { category: 'nature', sort: 'collection_display' },
  },
  {
    slug: 'limited-edition',
    title: 'Limited Edition',
    blurb: 'Short runs. Once they are gone, they are gone.',
    query: { category: 'limited-edition', sort: 'collection_display' },
  },
  {
    slug: 'new-arrivals',
    title: 'New Arrivals',
    blurb: 'The most recent additions to the catalogue.',
    query: { sort: 'newest' },
  },
]

/**
 * The five THEME collections, used to build the home page filter row.
 *
 * Deliberately not `COLLECTIONS.filter(c => c.query.category)` — limited-edition
 * is category-backed too, but it describes a release type rather than a theme
 * and does not belong in a row of subject filters.
 */
const THEME_SLUGS = ['architecture', 'fantasy', 'space', 'ocean', 'nature'] as const

export const CATEGORY_COLLECTIONS = THEME_SLUGS.map(
  slug => COLLECTIONS.find(c => c.slug === slug)!,
)

export function findCollection(slug: string): Collection | undefined {
  return COLLECTIONS.find(c => c.slug === slug)
}

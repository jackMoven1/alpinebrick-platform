import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { getProducts } from '../lib/api/catalog'
import type { ProductListPage } from '../lib/api/types'
import { ProductGrid } from '../components/ProductGrid'
import { CATEGORY_COLLECTIONS } from '../lib/collections'

interface HomeData {
  page: ProductListPage
  category: string | null
  search: string | null
}

export async function homeLoader({ request }: LoaderFunctionArgs): Promise<HomeData> {
  const url = new URL(request.url)
  const category = url.searchParams.get('category')
  const search = url.searchParams.get('q')
  const page = await getProducts({
    category: category ?? undefined,
    search: search ?? undefined,
    // Merchandised home order. Rendering the array as received is the point —
    // never re-sort it in the component.
    sort: 'home_display',
    pageSize: 24,
  })
  return { page, category, search }
}

const FILTER_BASE =
  'text-xs font-semibold uppercase tracking-[0.16em] pb-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring'

export default function Home() {
  const { page, category, search } = useLoaderData() as HomeData

  return (
    <div>
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 pb-16">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-4">
          Alpine Brick Exchange
        </span>
        <h1
          className="text-5xl sm:text-6xl font-black uppercase tracking-[0.04em] text-foreground max-w-3xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Sets worth building twice
        </h1>
        <p className="mt-6 max-w-xl text-sm text-muted-foreground leading-relaxed">
          Custom-designed sets from independent designers, and collectible previously-sold sets
          acquired complete. Every design credits the person who made it.
        </p>
        <Link
          to="/collections"
          className="inline-flex items-center justify-center mt-10 px-6 py-3 text-xs font-semibold uppercase tracking-[0.16em] rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Browse collections
        </Link>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-24">
        <nav aria-label="Filter by category" className="flex flex-wrap gap-6 border-b border-border mb-10">
          <Link
            to="/"
            aria-current={!category ? 'page' : undefined}
            className={`${FILTER_BASE} ${
              !category
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            All
          </Link>
          {CATEGORY_COLLECTIONS.map(c => {
            const active = category === c.slug
            return (
              <Link
                key={c.slug}
                to={`/?category=${c.slug}`}
                aria-current={active ? 'page' : undefined}
                className={`${FILTER_BASE} ${
                  active
                    ? 'text-foreground border-b-2 border-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {c.title}
              </Link>
            )
          })}
        </nav>

        {search && (
          <p className="mb-8 text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {page.total} result{page.total === 1 ? '' : 's'} for “{search}”
          </p>
        )}

        <ProductGrid
          products={page.items}
          emptyMessage="No sets in this category yet — check back soon"
        />
      </section>
    </div>
  )
}

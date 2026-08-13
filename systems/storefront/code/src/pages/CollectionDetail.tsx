import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { findCollection, type Collection } from '../lib/collections'
import { getProducts } from '../lib/api/catalog'
import type { ProductListPage } from '../lib/api/types'
import { ProductGrid } from '../components/ProductGrid'
import { PageHeader } from '../components/PageHeader'

interface CollectionData {
  collection: Collection
  page: ProductListPage
}

export async function collectionLoader({ params }: LoaderFunctionArgs): Promise<CollectionData> {
  const collection = findCollection(params.slug ?? '')
  // Throw BEFORE fetching: an unknown slug is a 404, not an empty collection.
  // An empty grid would tell a customer the collection exists but has nothing
  // in it, which for a typo is simply wrong.
  if (!collection) throw new Response('Not found', { status: 404 })
  const page = await getProducts({ ...collection.query, pageSize: 24 })
  return { collection, page }
}

export default function CollectionDetail() {
  const { collection, page } = useLoaderData() as CollectionData
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
      <PageHeader eyebrow="Collection" title={collection.title} intro={collection.blurb} />
      <div className="mt-14">
        <ProductGrid products={page.items} />
      </div>
    </div>
  )
}

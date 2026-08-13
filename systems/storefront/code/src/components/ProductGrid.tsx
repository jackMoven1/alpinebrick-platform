import { ProductCard } from './ProductCard'
import type { Product } from '../lib/api/types'

/**
 * Renders products in the EXACT order received. The server owns merchandised
 * order; re-sorting here would disagree with the server the moment pagination
 * is involved, because page 2 would be sorted independently of page 1.
 */
export function ProductGrid({
  products,
  emptyMessage = 'No sets here yet — check back soon',
}: {
  products: Product[]
  emptyMessage?: string
}) {
  if (products.length === 0) {
    return (
      <p className="py-24 text-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
        {emptyMessage}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {products.map(p => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  )
}

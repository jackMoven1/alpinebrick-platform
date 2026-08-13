import { Link } from 'react-router'
import { Badge, Card, Eyebrow } from '../design-system/primitives'
import { deriveBadge } from '../lib/badge'
import { formatCents, minPriceCents } from '../lib/money'
import { imageUrl, imageSrcSet, CARD_WIDTHS } from '../lib/images'
import type { Product } from '../lib/api/types'

export function ProductCard({ product }: { product: Product }) {
  const price = minPriceCents(product)
  const badge = deriveBadge(product)
  const image = product.images[0]
  const category = product.categories[0]

  return (
    <Card className="group relative !p-0">
      {badge && (
        <div className="absolute top-3 left-3 z-10">
          <Badge tone={badge === 'Limited' ? 'primary' : 'accent'}>{badge}</Badge>
        </div>
      )}
      <Link
        to={`/product/${product.slug}`}
        className="block outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="aspect-[5/4] bg-muted overflow-hidden">
          {image && (
            <img
              src={imageUrl(image.storageKey, { width: 900 })}
              srcSet={imageSrcSet(image.storageKey, CARD_WIDTHS)}
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              alt={image.alt}
              // Intrinsic size reserves layout space; without it every card
              // reflows as images load.
              width={image.width}
              height={image.height}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          )}
        </div>
        <div className="p-5">
          {category && <Eyebrow className="mb-1.5">{category}</Eyebrow>}
          <h3
            className="text-lg font-black uppercase tracking-[0.06em] text-foreground group-hover:text-primary transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {product.name}
          </h3>
          <div className="mt-3 flex items-end justify-between gap-4">
            {price !== null && (
              <span className="text-base font-semibold text-foreground">{formatCents(price)}</span>
            )}
            {product.pieces !== null && (
              <span className="text-xs text-muted-foreground">
                {product.pieces.toLocaleString()} pieces
              </span>
            )}
          </div>
        </div>
      </Link>
    </Card>
  )
}

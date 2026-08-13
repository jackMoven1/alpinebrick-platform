import { useState, type ReactNode } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { getProduct, getAvailability } from '../lib/api/catalog'
import type { Availability, Product } from '../lib/api/types'
import { Badge, Button, Eyebrow, Tabs, type Tab } from '../design-system/primitives'
import { deriveBadge } from '../lib/badge'
import { formatCents, minPriceCents } from '../lib/money'
import { imageUrl, imageSrcSet, DETAIL_WIDTHS } from '../lib/images'
import { useCart } from '../lib/cart/CartContext'

interface ProductData {
  product: Product
  availability: Availability[]
}

export async function productLoader({ params }: LoaderFunctionArgs): Promise<ProductData> {
  const idOrSlug = params.id ?? ''
  const [product, availability] = await Promise.all([
    getProduct(idOrSlug),
    // Availability is supplementary. If the stock service is unhappy the page
    // must still render the product rather than 500 the whole route.
    getAvailability(idOrSlug).catch(() => [] as Availability[]),
  ])
  return { product, availability }
}

function SpecList({ product }: { product: Product }) {
  const rows: [string, ReactNode][] = []
  if (product.pieces !== null) rows.push(['Pieces', product.pieces.toLocaleString()])
  if (product.difficulty) rows.push(['Difficulty', product.difficulty])
  if (product.ageRecommendation) rows.push(['Age', product.ageRecommendation])
  if (product.dimensions) rows.push(['Dimensions', product.dimensions])
  const sku = product.variants[0]?.sku
  if (sku) rows.push(['Set number', sku])

  if (rows.length === 0) return null

  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
      {rows.map(([label, value]) => (
        <div key={label} className="border-b border-border pb-3">
          <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </dt>
          <dd className="mt-1 text-sm text-foreground capitalize">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function ProductDetail() {
  const { product, availability } = useLoaderData() as ProductData
  const { addItem } = useCart()
  const [activeImage, setActiveImage] = useState(0)
  const [added, setAdded] = useState(false)

  const variant = product.variants[0]
  const price = minPriceCents(product)
  const badge = deriveBadge(product)
  const image = product.images[activeImage] ?? product.images[0]

  // No availability record means unknown, not zero — do not block the sale on
  // a missing row. Only an explicit 0 disables the button.
  const stock = availability.find(a => a.variantId === variant?.id)
  const outOfStock = stock !== undefined && stock.available <= 0

  function handleAdd() {
    if (!variant) return
    addItem({
      variantId: variant.id,
      productId: product.id,
      productSlug: product.slug,
      name: product.name,
      priceCents: variant.priceCents,
      imageKey: product.images[0]?.storageKey ?? '',
    })
    setAdded(true)
    window.setTimeout(() => setAdded(false), 2000)
  }

  const tabs: Tab[] = []
  if (product.longDescription || product.features.length > 0) {
    tabs.push({
      id: 'description',
      label: 'Description',
      content: (
        <div>
          {product.longDescription && <p className="leading-relaxed">{product.longDescription}</p>}
          {product.features.length > 0 && (
            <ul className="mt-5 space-y-2 list-disc pl-5">
              {product.features.map(f => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      ),
    })
  }
  tabs.push({ id: 'specifications', label: 'Specifications', content: <SpecList product={product} /> })
  if (product.includes.length > 0) {
    tabs.push({
      id: 'in-the-box',
      label: 'In the box',
      content: (
        <ul className="space-y-2 list-disc pl-5">
          {product.includes.map(i => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ),
    })
  }
  if (product.builderNotes) {
    tabs.push({
      id: 'builder-notes',
      label: 'Builder notes',
      content: <p className="leading-relaxed">{product.builderNotes}</p>,
    })
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
      <div className="grid lg:grid-cols-2 gap-12">
        <div>
          <div className="aspect-[5/4] bg-muted overflow-hidden">
            {image && (
              <img
                src={imageUrl(image.storageKey, { width: 1400 })}
                srcSet={imageSrcSet(image.storageKey, DETAIL_WIDTHS)}
                sizes="(min-width: 1024px) 50vw, 100vw"
                alt={image.alt}
                width={image.width}
                height={image.height}
                className="w-full h-full object-cover"
              />
            )}
          </div>
          {product.images.length > 1 && (
            <div className="flex gap-3 mt-4">
              {product.images.map((img, i) => (
                <button
                  key={img.storageKey}
                  type="button"
                  onClick={() => setActiveImage(i)}
                  aria-label={`View ${img.alt}`}
                  aria-current={i === activeImage ? 'true' : undefined}
                  className={`w-20 aspect-[5/4] bg-muted overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    i === activeImage ? 'ring-2 ring-primary' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  {/* Empty alt: the button already carries the accessible name,
                      so announcing it twice is noise for a screen reader. */}
                  <img
                    src={imageUrl(img.storageKey, { width: 200 })}
                    alt=""
                    width={img.width}
                    height={img.height}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          {product.categories[0] && <Eyebrow className="mb-3">{product.categories[0]}</Eyebrow>}
          <div className="flex items-start gap-4">
            <h1
              className="text-4xl font-black uppercase tracking-[0.05em] text-foreground"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {product.name}
            </h1>
            {badge && <Badge tone={badge === 'Limited' ? 'primary' : 'accent'}>{badge}</Badge>}
          </div>

          {product.description && (
            <p className="mt-5 text-sm text-muted-foreground leading-relaxed">
              {product.description}
            </p>
          )}

          {price !== null && (
            <p className="mt-8 text-3xl font-semibold text-foreground">{formatCents(price)}</p>
          )}

          <div className="mt-8 flex items-center gap-4">
            <Button onClick={handleAdd} disabled={outOfStock || !variant}>
              {outOfStock ? 'Out of stock' : 'Add to cart'}
            </Button>
            {/* text-accent is pure white — the one state in this system that uses it. */}
            {added && (
              <span
                role="status"
                className="text-xs font-semibold uppercase tracking-[0.16em] text-accent"
              >
                Added ✓
              </span>
            )}
          </div>

          <div className="mt-12">
            <Tabs tabs={tabs} />
          </div>
        </div>
      </div>
    </div>
  )
}

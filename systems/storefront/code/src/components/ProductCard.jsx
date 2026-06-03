import React from 'react'

export default function ProductCard({ product }) {
  const mainVariant = product.variants?.[0]
  const price = mainVariant?.price ?? 0
  const currency = mainVariant?.currency ?? 'USD'

  // Images are { url, alt } objects per ADR-0001; first element is primary.
  const primaryImage = product.images?.[0]
  const imageUrl = primaryImage?.url || '/placeholder.png'
  // Prefer the authored alt; fall back to product name only when absent.
  const imageAlt = primaryImage?.alt || product.name || ''

  return (
    <div className="bg-white rounded-lg shadow hover:shadow-lg transition-shadow overflow-hidden">
      {/* Product Image */}
      <div className="aspect-square bg-gray-200 overflow-hidden">
        <img
          src={imageUrl}
          alt={imageAlt}
          className="w-full h-full object-cover hover:scale-105 transition-transform"
          onError={(e) => {
            e.target.src = '/placeholder.png'
          }}
        />
      </div>

      {/* Product Info */}
      <div className="p-4">
        <h3 className="text-lg font-semibold text-gray-900 line-clamp-2 mb-2">
          {product.name}
        </h3>

        <p className="text-sm text-gray-600 line-clamp-2 mb-3">
          {product.description}
        </p>

        {/* Categories */}
        {product.categories && product.categories.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {product.categories.slice(0, 2).map(category => (
              <span
                key={category}
                className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded"
              >
                {category}
              </span>
            ))}
          </div>
        )}

        {/* Price and Button */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">Price</p>
            <p className="text-2xl font-bold text-gray-900">
              {currency} {price.toFixed(2)}
            </p>
          </div>

          <button
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            onClick={() => {
              // TODO: Add to cart functionality
              console.log(`Add ${product.name} to cart`)
            }}
          >
            View Details
          </button>
        </div>

        {/* SKU Info */}
        {mainVariant?.sku && (
          <p className="text-xs text-gray-400 mt-2">
            SKU: {mainVariant.sku}
          </p>
        )}
      </div>
    </div>
  )
}

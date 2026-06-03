import React, { useState, useEffect, useRef } from 'react'
import catalogService from '../services/catalogService'
import ProductCard from './ProductCard'
import SearchBar from './SearchBar'

const ITEMS_PER_PAGE = 24

export default function ProductList() {
  const [products, setProducts] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [errorCode, setErrorCode] = useState(null)
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [sort, setSort] = useState('name_asc')
  const [currentPage, setCurrentPage] = useState(1)

  // Category options are not yet served by a facet endpoint (deferred to a
  // later ADR). Accumulate categories observed across loaded pages as a
  // best-effort filter list for v1, so the set never shrinks when paging.
  const knownCategoriesRef = useRef(new Set())
  const [categories, setCategories] = useState([])

  const totalPages = ITEMS_PER_PAGE > 0 ? Math.ceil(total / ITEMS_PER_PAGE) : 0

  // Reset to page 1 whenever a filter/search/sort changes.
  useEffect(() => {
    setCurrentPage(1)
  }, [search, selectedCategory, sort])

  // Server is the source of truth: refetch on any param change. No client-side
  // re-filtering or slicing.
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)
        setErrorCode(null)
        const response = await catalogService.getProducts({
          search: search || undefined,
          category: selectedCategory || undefined,
          sort,
          page: currentPage,
          limit: ITEMS_PER_PAGE,
        })
        if (cancelled) return

        setProducts(response.products)
        setTotal(response.total)

        // Merge any newly-seen categories into the filter list.
        let changed = false
        response.products.forEach(product => {
          if (Array.isArray(product.categories)) {
            product.categories.forEach(cat => {
              if (!knownCategoriesRef.current.has(cat)) {
                knownCategoriesRef.current.add(cat)
                changed = true
              }
            })
          }
        })
        if (changed) {
          setCategories(Array.from(knownCategoriesRef.current).sort())
        }
      } catch (err) {
        if (cancelled) return
        // NOT_FOUND is an empty result, not a hard failure: show empty state.
        if (err.code === 'NOT_FOUND') {
          setProducts([])
          setTotal(0)
        } else {
          setError(err.message || 'Failed to load products')
          setErrorCode(err.code || 'INTERNAL')
          setProducts([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [search, selectedCategory, sort, currentPage])

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading products...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-red-800 mb-2">Error Loading Products</h3>
        <p className="text-red-700">{error}</p>
        <button
          onClick={() => setCurrentPage(p => p)}
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    )
  }

  const showingCount = products.length

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-8">Our Products</h2>

      {/* Search and Filter Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <SearchBar
          search={search}
          onSearchChange={setSearch}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          categories={categories}
          sort={sort}
          onSortChange={setSort}
        />

        {total > 0 && (
          <p className="text-sm text-gray-600 mt-4">
            Showing {showingCount} of {total} products
          </p>
        )}
      </div>

      {/* Products Grid */}
      {products.length > 0 ? (
        <div className="mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {products.map(product => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 mt-8">
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page)}
                  className={`px-3 py-2 rounded ${
                    currentPage === page
                      ? 'bg-blue-600 text-white'
                      : 'border border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {page}
                </button>
              ))}

              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-600 text-lg">
            {search || selectedCategory
              ? 'No products match your search criteria.'
              : 'No products available yet.'}
          </p>
        </div>
      )}
    </div>
  )
}

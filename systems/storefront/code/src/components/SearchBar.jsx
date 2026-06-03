import React from 'react'

export default function SearchBar({
  search,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  categories,
}) {
  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Search Products
        </label>
        <input
          type="text"
          placeholder="Search by name or description..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* Category Filter */}
      {categories.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Filter by Category
          </label>
          <select
            value={selectedCategory}
            onChange={(e) => onCategoryChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Categories</option>
            {categories.map(category => (
              <option key={category} value={category}>
                {category.charAt(0).toUpperCase() + category.slice(1)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Clear Filters Button */}
      {(search || selectedCategory) && (
        <button
          onClick={() => {
            onSearchChange('')
            onCategoryChange('')
          }}
          className="text-sm text-blue-600 hover:text-blue-700 underline"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

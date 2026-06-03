import React, { useState, useEffect } from 'react'
import './styles/index.css'
import ProductList from './components/ProductList'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <nav className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">ImagiBricks</h1>
          <p className="text-gray-600">Premium Construction Sets & Toys</p>
        </nav>
      </header>
      
      <main className="max-w-7xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <ProductList />
      </main>
      
      <footer className="bg-gray-800 text-white py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p>&copy; 2026 ImagiBricks. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}

export default App

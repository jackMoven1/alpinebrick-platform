import { Routes, Route } from 'react-router-dom'
import { ToastProvider } from './ui/toast.jsx'
import ConsoleShell from './shell/ConsoleShell.jsx'
import CatalogOverview from './catalog/CatalogOverview.jsx'
import ProductList from './catalog/ProductList.jsx'
import ProductForm from './catalog/ProductForm.jsx'
import ProductDetail from './catalog/ProductDetail.jsx'

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<ConsoleShell />}>
          <Route index element={<CatalogOverview />} />
          <Route path="products" element={<ProductList />} />
          <Route path="products/new" element={<ProductForm />} />
          <Route path="products/:id" element={<ProductDetail />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}

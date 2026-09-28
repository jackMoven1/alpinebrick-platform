import { PageHeader } from '../components/PageHeader'
import CartPanel from '../components/cart/CartPanel'

export default function Cart() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-10">
      <PageHeader eyebrow="Cart" title="Your cart" />
      <CartPanel />
    </div>
  )
}

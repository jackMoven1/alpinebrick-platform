import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'
import { Link } from 'react-router'

export default function Shipping() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
      <PageHeader
        eyebrow="Support"
        title="Shipping"
        intro="How orders are packed, dispatched and tracked. Shipping options and their exact cost are calculated and shown at checkout, before any payment."
      />

      <Card className="mt-10">
        <h2 className="text-lg font-semibold tracking-[0.12em] mb-4">How Shipping Works</h2>
        <p className="mb-4">
          When you place an order, shipping options and their exact costs are calculated and displayed at checkout before you make any payment. This allows you to see the total cost of your purchase, including shipping, before completing your order.
        </p>
        
        <p className="mb-4">
          All items are carefully packed to protect them during transit. We use appropriate packaging materials to ensure your items arrive in the same condition they left our facility.
        </p>
        
        <p className="mb-4">
          Once your order ships, you will receive a tracking reference that you can use to monitor your shipment's progress. Visit our <Link to="/support/track-order">order tracking page</Link> and enter your tracking reference to get real-time updates on your delivery.
        </p>
        
        <p>
          If you have any questions about shipping or need assistance with your order, please contact us at <a href="mailto:alpinebrick@gmail.com" className="underline">alpinebrick@gmail.com</a>.
        </p>
      </Card>
    </div>
  )
}
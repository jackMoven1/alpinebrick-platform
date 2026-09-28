import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'

/** Placeholder until launch readiness (sub-project 3) supplies reviewed terms. */
export default function Terms() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-6">
      <PageHeader eyebrow="Legal" title="Terms of sale" />
      <p className="text-sm text-muted-foreground">
        Our terms of sale are being finalised. Questions about an order? Visit <Link to="/support" className="underline">Support</Link>.
      </p>
    </div>
  )
}

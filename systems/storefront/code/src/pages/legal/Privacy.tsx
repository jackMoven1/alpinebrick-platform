import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'

/** Placeholder until launch readiness (sub-project 3) supplies a reviewed policy. */
export default function Privacy() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-6">
      <PageHeader eyebrow="Legal" title="Privacy" />
      <p className="text-sm text-muted-foreground">
        Our privacy policy is being finalised. Questions? Visit <Link to="/support" className="underline">Support</Link>.
      </p>
    </div>
  )
}

import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'
import { Link } from 'react-router'

// Root already renders the <main> landmark. A page must not add a second one:
// nested main landmarks break the skip link and give screen readers two "main"
// regions to choose between.
export default function Careers() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
      <PageHeader
        eyebrow="Working at Alpine Brick"
        title="Careers"
        intro="Alpine Brick Exchange is a small operation built around set design, sourcing and grading collectible sets, packing and fulfilment, and customer support. We are not actively hiring — but we read every message."
      />

      <section className="mt-12">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Open roles
        </span>
        <h2 className="text-2xl font-bold uppercase tracking-[0.05em] text-foreground">
          No open positions right now
        </h2>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          There are no open roles at this time. When a vacancy opens, it will be
          listed here in full — with the role, the work, and how to apply. If you
          do not see a listing, there is nothing open.
        </p>
      </section>

      <Card className="mt-8">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Tell us what you do
        </span>
        <h2 className="text-xl font-bold uppercase tracking-[0.05em] text-foreground">
          A speculative approach
        </h2>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          We keep a file of people who get in touch. If you have a craft that
          fits this kind of business — set design, grading, packing and
          fulfilment, support, or something else we have not thought of — write
          to us and tell us what you do and how you work. There is no job to
          apply for, so do not treat this as one. When a real vacancy opens, the
          people in that file are where we look first.
        </p>
        <p className="mt-6 text-sm text-foreground leading-relaxed">
          Write to{' '}
          <a
            href="mailto:alpinebrick@gmail.com"
            className="underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            alpinebrick@gmail.com
          </a>
          .
        </p>
      </Card>

      <p className="mt-10 text-sm text-muted-foreground">
        <Link
          to="/"
          className="uppercase tracking-[0.16em] text-xs font-semibold underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Back to the catalogue
        </Link>
      </p>
    </div>
  )
}

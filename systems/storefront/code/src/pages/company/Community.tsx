import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

export default function Community() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <PageHeader
        eyebrow="Community"
        title="Building Events"
        intro="Alpine Brick Exchange intends to bring brick builders together in person. The programme is early in its planning and nothing about it is settled yet."
      />

      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            What We Want To Do
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">In-person building events</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The plan is to host in-person events where brick builders can meet, share techniques,
            and build side by side. We want these gatherings to be welcoming to collectors and
            builders alike, whether they are new to the hobby or have been building for years.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            What Is Settled
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">The intent, not the details</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            What is settled is that we intend to host these events. What is not settled is the rest
            of the programme. Dates and venues are not announced yet, and we are not taking bookings
            at this stage.
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Register Interest
        </span>
        <h2 className="text-lg font-bold text-foreground mb-3">Tell us you would come</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          If in-person building events sound like something you would attend, let us know. Write to
          us at the address below and we will keep your interest on file. When we have something
          concrete to share about dates or venues, you will hear from us.
        </p>
        <p className="mt-4 text-sm text-foreground leading-relaxed">
          Reach us at:{' '}
          <span className="font-semibold uppercase tracking-[0.16em]">
            alpinebrick@gmail.com
          </span>
        </p>
      </Card>

      <div className="mt-10">
        <Link
          to="/"
          className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground underline underline-offset-4 hover:text-muted-foreground"
        >
          Back to home
        </Link>
      </div>
    </div>
  )
}

import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

export default function Designers() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-20 sm:py-28">
      <PageHeader
        eyebrow="The Designer Programme"
        title="Designers"
        intro="Alpine Brick sells custom-designed sets created by independent designers — and we share the revenue with the people who design them."
      />

      <div className="mt-14 grid gap-8 sm:grid-cols-2">
        <Card>
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            How the programme works
          </h2>
          <p className="text-sm leading-relaxed text-foreground">
            Every set in the Alpine Brick catalogue is a custom design. Each set
            is credited to exactly one designer — the person whose idea, parts
            list, and instructions brought it to life.
          </p>
        </Card>

        <Card>
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Earning a share of revenue
          </h2>
          <p className="text-sm leading-relaxed text-foreground">
            A designer earns a share of the revenue on every sale of a set they
            designed — for as long as that set sells. There is no expiry on the
            work. We are still settling the exact rate; what is settled is that
            designers get a share of revenue on every sale.
          </p>
        </Card>

        <Card>
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            One designer, one set
          </h2>
          <p className="text-sm leading-relaxed text-foreground">
            Each set has exactly one designer credited. We keep attribution
            simple and legible, so it is always clear whose work you are buying.
          </p>
        </Card>

        <Card>
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Get in touch
          </h2>
          <p className="text-sm leading-relaxed text-foreground">
            If you design custom sets and want yours in the Alpine Brick
            catalogue, write to us. Tell us about the sets you make and where we
            can see your work.
          </p>
          <a
            href="mailto:alpinebrick@gmail.com"
            className="inline-block mt-4 text-sm font-semibold uppercase tracking-[0.16em] text-foreground underline underline-offset-4"
          >
            alpinebrick@gmail.com
          </a>
        </Card>
      </div>

      <p className="mt-12 text-sm text-muted-foreground">
        Ready to look around?{' '}
        <Link
          to="/"
          className="font-semibold uppercase tracking-[0.16em] text-foreground underline underline-offset-4"
        >
          Browse the catalogue
        </Link>
      </p>
    </div>
  )
}

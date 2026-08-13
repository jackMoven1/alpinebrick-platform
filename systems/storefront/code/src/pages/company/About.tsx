import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

export default function About() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <PageHeader
        eyebrow="About Us"
        title="Alpine Brick Exchange"
        intro="Alpine Brick Exchange has been trading since 2021, building a focused catalog of brick sets for collectors and builders."
      />

      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            What We Sell
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">Two kinds of sets</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Alpine Brick Exchange sells two things: custom-designed sets created by independent
            designers, and collectible previously-sold sets acquired complete and ready to display.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Not Affiliated
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">A note on the LEGO Group</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Alpine Brick Exchange is not affiliated with the LEGO Group. The LEGO Group does not
            sponsor, endorse, or authorize this business.
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Our Story
        </span>
        <h2 className="text-lg font-bold text-foreground mb-3">Since 2021</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Alpine Brick Exchange has been trading since 2021. Beyond that, further details about the
          business are not published yet.
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

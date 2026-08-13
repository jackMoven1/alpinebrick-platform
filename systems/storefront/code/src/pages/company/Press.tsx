import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

// Root already renders the <main> landmark. A page must not add a second one:
// nested main landmarks break the skip link and give screen readers two "main"
// regions to choose between.
export default function Press() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
      <PageHeader
        eyebrow="Press & Media"
        title="Press"
        intro="Alpine Brick Exchange is a brick-set specialist trading since 2021, selling custom-designed sets by independent designers and collectible previously-sold sets. It is not affiliated with the LEGO Group."
      />

      <section className="mt-12">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Coverage
        </span>
        <h2 className="text-2xl font-bold uppercase tracking-[0.05em] text-foreground">
          No press coverage yet
        </h2>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          Alpine Brick Exchange has not been covered by the press so far. There
          are no articles, interviews, or features to link to at this time. When
          that changes, they will be listed here in full with the outlet, the
          date, and a link to the piece.
        </p>
      </section>

      <Card className="mt-8">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          For Journalists
        </span>
        <h2 className="text-xl font-bold uppercase tracking-[0.05em] text-foreground">
          Media enquiries
        </h2>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          If you are writing about Alpine Brick Exchange, the brick-set
          secondary market, or independent set designers, write to us and we
          will reply with what we can share. We can confirm the facts above —
          trading since 2021, custom-designed sets by independent designers,
          collectible previously-sold sets, and no affiliation with the LEGO
          Group — and answer questions about how the business works.
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

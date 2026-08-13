import { Link } from 'react-router'
import { Card } from '../design-system/primitives'
import { PageHeader } from '../components/PageHeader'
import { COLLECTIONS } from '../lib/collections'

export default function Collections() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
      <PageHeader
        eyebrow="Browse"
        title="Collections"
        intro="Seven ways into the catalogue. Every collection is ordered the way we would arrange it on a shelf."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-14">
        {COLLECTIONS.map(c => (
          <Card key={c.slug} className="!p-0">
            <Link
              to={`/collections/${c.slug}`}
              className="block p-8 outline-none focus-visible:ring-2 focus-visible:ring-ring group"
            >
              <h2
                className="text-2xl font-black uppercase tracking-[0.06em] text-foreground group-hover:text-primary transition-colors"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {c.title}
              </h2>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{c.blurb}</p>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  )
}

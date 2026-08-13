import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

type SupportTopic = {
  to: string
  label: string
  description: string
}

const SUPPORT_TOPICS: SupportTopic[] = [
  {
    to: '/support/faq',
    label: 'FAQ',
    description: 'Answers to the questions customers ask most often about sets, orders, and accounts.',
  },
  {
    to: '/support/shipping',
    label: 'Shipping',
    description: 'How orders are packed, where they ship from, and what to expect at checkout.',
  },
  {
    to: '/support/returns',
    label: 'Returns',
    description: 'How to start a return, what condition sets should be in, and how refunds work.',
  },
  {
    to: '/support/track-order',
    label: 'Track Order',
    description: 'Find an order by its number and see its current status.',
  },
  {
    to: '/support/contact',
    label: 'Contact',
    description: 'Send a message to the team and we will reply by email.',
  },
]

export default function Support() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <PageHeader
        eyebrow="Support"
        title="Support Center"
        intro="Find answers, track an order, or get in touch. Pick a topic below to get started."
      />

      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {SUPPORT_TOPICS.map(topic => (
          <Link key={topic.to} to={topic.to} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="h-full">
              <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
                {topic.label}
              </span>
              <h2 className="text-lg font-bold text-foreground mb-2">{topic.label}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{topic.description}</p>
              <span className="mt-4 inline-block text-xs font-semibold uppercase tracking-[0.16em] text-foreground underline underline-offset-4">
                Visit {topic.label}
              </span>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Email
        </span>
        <h2 className="text-lg font-bold text-foreground mb-3">Email the team</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Customers can email alpinebrick@gmail.com for anything not covered above.
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

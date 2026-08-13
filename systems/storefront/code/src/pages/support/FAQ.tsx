import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Accordion, type AccordionItem } from '../../design-system/primitives'

const FAQ_ITEMS: AccordionItem[] = [
  {
    id: 'what-we-sell',
    question: 'What does Alpine Brick Exchange sell?',
    answer: (
      <>
        Alpine Brick Exchange sells two kinds of sets. The first is
        custom-designed sets created by independent designers, built from
        genuine LEGO parts and produced in small runs. The second is
        collectible previously-sold sets, sourced from past releases and
        offered to collectors who missed them the first time around.
      </>
    ),
  },
  {
    id: 'collectible-condition',
    question: 'What condition do the collectible previously-sold sets arrive in?',
    answer: (
      <>
        Every collectible previously-sold set is inspected before it is
        listed. Each set is checked against the original inventory for the
        release so we can confirm what is inside. The listing for each set
        describes its actual condition, including any missing pieces or
        notable wear, so you know what you are buying before you check out.
      </>
    ),
  },
  {
    id: 'how-ordering-works',
    question: 'How does ordering work?',
    answer: (
      <>
        Add a set to your cart, proceed to checkout, and enter your shipping
        details. Shipping options and costs are shown at checkout before you
        pay. You can pay by card through our secure checkout. Once your order
        is placed you will receive an order number you can use to track it.
      </>
    ),
  },
  {
    id: 'limited-stock',
    question: 'Are limited runs really limited?',
    answer: (
      <>
        Yes. Custom-designed sets are produced in small runs by independent
        designers, and stock on those runs is genuinely limited. Once a run
        sells out, it may not be restocked. If a set is marked as a limited
        run, the number shown is the number available.
      </>
    ),
  },
  {
    id: 'track-order',
    question: 'Where can I track my order?',
    answer: (
      <>
        You can track any order from the Track Order page using your order
        number.{' '}
        <Link
          to="/support/track-order"
          className="underline underline-offset-4 text-foreground"
        >
          Go to Track Order
        </Link>
        .
      </>
    ),
  },
  {
    id: 'returns',
    question: 'What is your returns policy?',
    answer: (
      <>
        Returns are explained in full on our Returns page, including how to
        start a return, what condition a set should be in, and how refunds
        are issued.{' '}
        <Link
          to="/support/returns"
          className="underline underline-offset-4 text-foreground"
        >
          Read the Returns page
        </Link>
        .
      </>
    ),
  },
  {
    id: 'not-affiliated',
    question: 'Is Alpine Brick Exchange affiliated with the LEGO Group?',
    answer: (
      <>
        No. Alpine Brick Exchange is not affiliated with, endorsed by, or
        sponsored by the LEGO Group. LEGO is a trademark of the LEGO Group
        of companies. The sets we sell are built from genuine LEGO parts, but
        Alpine Brick Exchange is an independent business.
      </>
    ),
  },
  {
    id: 'reach-a-human',
    question: 'How do I reach a real person?',
    answer: (
      <>
        Email us at alpinebrick@gmail.com and a member of the team will read
        your message and reply. Tell us your order number if your question is
        about an order you have already placed.
      </>
    ),
  },
  {
    id: 'shipping-options',
    question: 'How much does shipping cost, and how long does it take?',
    answer: (
      <>
        Shipping options and costs are shown at checkout before you pay, and
        depend on where the order is being shipped. We do not quote fixed
        shipping rates or delivery times on this page because they can vary by
        destination and by the set in your cart.
      </>
    ),
  },
]

export default function FAQ() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <PageHeader
        eyebrow="Support"
        title="Frequently Asked Questions"
        intro="Answers to the questions customers ask most about our sets, orders, shipping, and returns."
      />

      <div className="mt-12">
        <Accordion items={FAQ_ITEMS} />
      </div>

      <div className="mt-10">
        <Link
          to="/support"
          className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground underline underline-offset-4 hover:text-muted-foreground"
        >
          Back to Support
        </Link>
      </div>
    </div>
  )
}

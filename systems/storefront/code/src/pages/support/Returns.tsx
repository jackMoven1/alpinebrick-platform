import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../design-system/primitives'

export default function Returns() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <PageHeader
        eyebrow="Support"
        title="Returns"
        intro="If a set you ordered needs to go back, this page walks through how to start a return, what condition to send it in, and how refunds are issued."
      />

      <div className="mt-12 space-y-6">
        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Step One
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            Email us to start a return
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Before anything else, get in touch. Email{' '}
            <a
              href="mailto:alpinebrick@gmail.com"
              className="underline underline-offset-4 text-foreground"
            >
              alpinebrick@gmail.com
            </a>{' '}
            with your order number and a short note about what you would like to
            return. We read every message and will reply with the next steps,
            including exactly where the set needs to be sent. Do not send
            anything back before you hear from us, because a parcel that arrives
            without instructions from us can be hard to match up with your order
            and may delay your return.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Step Two
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            Wait for our reply before shipping
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Once we have your email, we will confirm that a return is the right
            next step and tell you where to send the set. We will also let you
            know anything else we need from you at that point. Sending a return
            to the wrong address, or before we have agreed it, is the most
            common reason a refund gets held up, so please wait for our reply
            before packing anything up.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Condition
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            Return sets in the condition they arrived in
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            When you send a set back, it should arrive in the condition it was in
            when it reached you. Keep the original packaging where possible,
            and pack the pieces so they do not shift around in transit. If
            anything is missing or damaged when the return reaches us, we will
            be in touch before any refund is issued.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Damaged In Transit
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            If a set arrives damaged, send photographs
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            If a set is damaged in transit, do not throw the packaging away.
            Email alpinebrick@gmail.com with your order number and clear
            photographs of the damage, the box, and any packing material. The
            photographs help us understand what happened and sort the return out
            with the carrier. We will reply with what to do next and where to
            send the set if it needs to come back to us.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Refunds
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            Refunds go back to the original payment method
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Once a return has been agreed and the set has reached us, the refund
            is issued back to the original payment method you used at checkout.
            We cannot refund to a different card or account. How long the refund
            takes to show up depends on your bank or card issuer, and is outside
            our control once the refund has been issued.
          </p>
        </Card>

        <Card>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Questions
          </span>
          <h2 className="text-lg font-bold text-foreground mb-3">
            Still unsure? Email us
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            If anything on this page does not cover your situation, email{' '}
            <a
              href="mailto:alpinebrick@gmail.com"
              className="underline underline-offset-4 text-foreground"
            >
              alpinebrick@gmail.com
            </a>{' '}
            with your order number and we will help you figure out the right
            next step.
          </p>
        </Card>
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

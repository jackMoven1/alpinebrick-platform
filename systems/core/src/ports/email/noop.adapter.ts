import type { EmailPort } from './email.port.js'

export const noopEmailAdapter: EmailPort = {
  async orderPaid() {
    // Intentionally empty (D5): Stripe's receipt is the customer's email.
  },
}

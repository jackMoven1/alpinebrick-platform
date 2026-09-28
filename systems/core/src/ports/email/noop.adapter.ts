import type { EmailPort } from './email.port.js'

export const noopEmailAdapter: EmailPort = {
  async orderPaid() {
    // Intentionally empty until spec §9.1 (receipts) is settled.
  },
}

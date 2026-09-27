export interface OrderPaidEmail {
  orderId: string
  orderNumber: string
  email: string
}

/**
 * Transactional email seam (D5). Stripe sends receipts at launch; nothing
 * but the webhook's single orderPaid call uses this until shipped/tracking
 * emails land.
 */
export interface EmailPort {
  orderPaid(input: OrderPaidEmail): Promise<void>
}

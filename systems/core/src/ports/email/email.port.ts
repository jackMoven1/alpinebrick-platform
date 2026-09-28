export interface OrderPaidEmail {
  orderId: string
  orderNumber: string
  email: string
}

/**
 * Transactional email seam (D5). The pay route and payment.updated call
 * orderPaid once per paid order. Whether Square emails a receipt for API
 * payments is open item §9.1 of the Square spec (sandbox check 8). If it
 * does not, a real adapter goes here -- Jack chooses the provider.
 */
export interface EmailPort {
  orderPaid(input: OrderPaidEmail): Promise<void>
}

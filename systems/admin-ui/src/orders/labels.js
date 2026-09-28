/** Queue tabs (spec §7). ids are core's `tab` values. */
export const ORDER_TABS = [
  { id: 'to_ship', label: 'To ship' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'pending', label: 'Pending' },
  { id: 'closed', label: 'Closed' },
  { id: 'review', label: 'Needs review' },
]

export const REVIEW_LABELS = {
  amount_mismatch: 'Amount mismatch',
  paid_after_cancel: 'Paid after cancel',
  outside_shipping_area: 'Outside shipping area',
  disputed: 'Disputed',
}

/** "Shipped" in the console is core's `fulfilled` status (spec §2). */
export const STATUS_LABELS = {
  pending: 'Pending', paid: 'Paid', fulfilled: 'Shipped', cancelled: 'Cancelled', refunded: 'Refunded',
}

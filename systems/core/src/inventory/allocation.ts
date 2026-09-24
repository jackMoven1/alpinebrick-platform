/**
 * What each channel may sell from one variant's stock (spec §5.1).
 *
 * allocation === null  -> shared: both channels see on_hand - reserved.
 * allocation === N     -> split: Walmart sees min(N, free), the storefront
 *                         the free units that are NOT allocated.
 *
 * These are the READ-side figures. The write-side guards live in the SQL of
 * placeOrder, ingestWalmartOrder and setStock and must agree with them.
 */
export function storefrontSellable(onHand: number, reserved: number, allocation: number | null): number {
  return Math.max(0, onHand - reserved - (allocation ?? 0))
}

export function walmartSellable(onHand: number, reserved: number, allocation: number | null): number {
  const free = Math.max(0, onHand - reserved)
  return allocation === null ? free : Math.min(allocation, free)
}

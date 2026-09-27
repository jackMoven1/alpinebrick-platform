export interface ShippingQuoteInput {
  subtotalCents: number
  /** Unused by the flat-rate adapter; a carrier adapter needs the variants' weights. */
  lines: { variantId: string; quantity: number }[]
}

export interface ShippingOption {
  displayName: string
  amountCents: number
}

/** Spec §3 / D2: flat rate at launch; a carrier-rate adapter may follow. */
export interface ShippingPort {
  quote(input: ShippingQuoteInput): Promise<ShippingOption[]>
}

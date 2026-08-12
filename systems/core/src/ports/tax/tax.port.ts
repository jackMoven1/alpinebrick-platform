export interface TaxLineItem {
  amountCents: number
}

export interface TaxInput {
  shipToState: string
  lineItems: TaxLineItem[]
}

export interface TaxResult {
  taxCents: number
  rateBps: number
  jurisdiction: string
}

export interface TaxPort {
  computeTax(input: TaxInput): Promise<TaxResult>
}

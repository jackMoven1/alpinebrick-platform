// Shared fixtures for Walmart channel tests. Kept in tests/helpers so every
// test file that needs a sample order imports it from one place, instead of
// importing another *.test.ts file for its side effect of also registering
// that file's own describe/it blocks (which double-runs them and inflates
// the test count when the fixture-importing file runs).

// Trimmed from a real sandbox order response shape (Orders API v3).
export const walmartOrderFixture = {
  purchaseOrderId: 'PO-1001',
  customerOrderId: 'CO-9001',
  customerEmailId: 'mgr@relay.walmart.com',
  orderDate: 1754160000000,
  shippingInfo: { postalAddress: { state: 'MI', postalCode: '48823' } },
  orderLines: {
    orderLine: [
      {
        lineNumber: '1',
        item: { sku: 'ABE-SET-001-W', productName: 'Castle Set' },
        orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '2' },
        charges: {
          charge: [
            {
              chargeType: 'PRODUCT',
              chargeAmount: { currency: 'USD', amount: 49.99 },
              tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 3.0 } },
            },
          ],
        },
      },
    ],
  },
}

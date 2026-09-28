// Ruling P13 (carried over): buildApp() builds the payments port from env at
// construction time. A developer machine with stray SQUARE_* keys set (or
// only some of them) would make createPaymentsPort() throw, and every test
// file that builds the app at module scope would fail to load. Clearing them
// keeps buildApp() defaulting to unconfiguredPaymentsPort. Tests that need
// payments pass a payments dep explicitly (see tests/helpers/checkout.ts).
// STRIPE_* are cleared too, so the leftover-key warning stays out of test output.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SQUARE_') || key.startsWith('STRIPE_')) delete process.env[key]
}
delete process.env.STOREFRONT_PUBLIC_URL

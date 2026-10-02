// Ruling P13: buildApp() (used with no deps by several test files, e.g.
// cors.test.ts and auth-route-coverage.test.ts) now builds the payments port
// from env at construction time. A developer machine with a stray
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET set (or only one of the pair)
// would make createPaymentsPort() throw -- and every test file that builds
// the app at module scope would fail to load, not just the checkout tests.
// Clearing these before the suite runs keeps buildApp() defaulting to
// unconfiguredPaymentsPort. Tests that need Stripe pass a payments dep
// explicitly (see tests/helpers/checkout.ts).
delete process.env.STRIPE_SECRET_KEY
delete process.env.STRIPE_WEBHOOK_SECRET
delete process.env.STOREFRONT_PUBLIC_URL

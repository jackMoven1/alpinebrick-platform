import { buildApp } from './app.js'
import { createPaymentsPort } from './ports/payments/index.js'
import { startCheckoutSweep } from './checkout/sweep.js'

const port = Number(process.env.PORT ?? 4000)
// One port for the app and the sweep. createPaymentsPort throws on a
// half-configured Stripe, so the process refuses to start (spec §8).
const payments = createPaymentsPort()
buildApp({ payments }).listen(port, () => console.log(`core listening on :${port}`))
startCheckoutSweep(payments)

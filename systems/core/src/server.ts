import { buildApp } from './app.js'
import { createPaymentsPort } from './ports/payments/index.js'
import { startCheckoutSweep } from './checkout/sweep.js'

const port = Number(process.env.PORT ?? 4000)
// One port for the app and the sweep. createPaymentsPort throws on a
// partial Square config, so the process refuses to start (spec 2026-09-28 §4).
const payments = createPaymentsPort()
buildApp({ payments }).listen(port, () => console.log(`core listening on :${port}`))
startCheckoutSweep(payments)

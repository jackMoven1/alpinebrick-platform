// Background worker entrypoint for the Walmart Marketplace channel --
// outbox drain, order/return pollers, hourly inventory reconciliation, and
// (opt-in) settlement import. There is no price reconciliation: prices reach
// Walmart only through `walmart_push_price` jobs (price.sync.ts). Deployed separately from the web process (see
// `render.yaml`'s commented-out `core-worker` service): `server.ts` never
// starts this scheduler, so every web instance can scale independently
// without each one also polling Walmart and draining the outbox in
// duplicate. Ruling: Task 13 brief.
//
// ONLY PROVISION THIS WORKER WITH WALMART_SYNC_ENABLED=true. With the flag
// unset it logs and exits 0 on purpose (behaviour unchanged, final fix wave
// B6) -- but a Render background worker that exits is restarted, so a
// core-worker deployed without the flag crash-loops: start, exit, restart,
// forever, doing nothing. Leave the service unprovisioned until sync is
// meant to run.
import { prisma } from './prisma.js'
import { startWalmartScheduler, stopWalmartScheduler } from './channels/walmart/scheduler.js'

function main(): void {
  if (process.env.WALMART_SYNC_ENABLED !== 'true') {
    console.log('walmart worker: WALMART_SYNC_ENABLED is not "true" -- sync disabled, exiting')
    process.exit(0)
  }

  const settlement = process.env.WALMART_SETTLEMENT_ENABLED === 'true'
  console.log(`walmart worker: starting scheduler (settlement ${settlement ? 'enabled' : 'disabled'})`)
  // keepAlive: true -- this process has nothing else on the event loop, so
  // unref'd intervals (the scheduler's own default, which tests rely on)
  // would let node exit right after this call returns.
  startWalmartScheduler(undefined, { keepAlive: true, settlement })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`walmart worker: received ${signal}, shutting down`)
    stopWalmartScheduler()
    prisma.$disconnect()
      .catch((e) => console.error('walmart worker: error disconnecting prisma', e))
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()

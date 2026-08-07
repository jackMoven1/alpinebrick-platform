# Phase 1 · Plan 2 — Orders + Inventory + Tax Implementation Plan

> **For agentic workers:** This plan is executed by **Ringer** (the verified-swarm
> engine) — one Ringer task per plan task, verified by an executed check that runs
> the task's vitest file(s) against a real Postgres. Steps use checkbox (`- [ ]`)
> syntax for tracking. The plan itself is engine-agnostic: every task ends with an
> independently testable deliverable and could equally be run via
> superpowers:subagent-driven-development. See **Execution & Ringer batching** at
> the end for task dependencies and how they map to Ringer rounds.

**Goal:** Add the order spine to `systems/core` — placing an order computes sales
tax through a Tax port, reserves inventory atomically, and persists an auditable
order; fulfillment decrements stock, cancellation releases it.

**Architecture:** Order is the domain spine. Tax is a **port** (`TaxPort`) with a
flat nexus-rate adapter (Michigan @ 6%) as the Phase-1 implementation, swappable for
Stripe Tax / Avalara later with zero changes to the order service. Inventory follows
**reserve-on-order, decrement-on-fulfillment**: placing an order raises `reserved`;
fulfillment lowers `on_hand` and `reserved`; cancellation lowers `reserved`. All
stock mutations use race-safe conditional SQL so concurrent orders cannot oversell.

**Tech Stack:** TypeScript (ESM, `"type":"module"`, `.js` import specifiers),
Express 4, Prisma 5 + PostgreSQL, Vitest 2 + supertest. Money is **integer cents**;
tax rates are **integer basis points** (6% = `600` bps). No floats in persisted money.

## Global Constraints

- **Money = integer cents.** Never store or compute money as a float. `totalCents = subtotalCents + taxCents`.
- **Tax rate = integer basis points.** `taxCents = Math.round(subtotalCents * rateBps / 10000)`.
- **ESM import specifiers end in `.js`** even for `.ts` files (e.g. `import { prisma } from '../prisma.js'`).
- **Published-only:** an order line may only reference a variant whose product `status = 'published'`.
- **Every state transition writes an audit row** via `recordAudit` (actor defaults to the seeded `'system'` actor).
- **Tests run against real Postgres**, not mocks. Container `alpinebrick-core-db` on port 5433; `DATABASE_URL` points at it. `vitest.config.ts` already sets `fileParallelism:false`.
- **New models must be added to `tests/helpers/db.ts` `resetDb()`** in child-before-parent delete order, or every other test's `beforeEach` breaks.
- **Commit format:** conventional (`feat(core):`, `fix(core):`, `test(core):`). Frequent commits — one per task minimum.

## File Structure

- `src/ports/tax/tax.port.ts` — **create.** Port interface + input/result types. No DB.
- `src/ports/tax/flat-rate.adapter.ts` — **create.** Flat nexus-rate adapter (MI=600bps). Pure.
- `src/orders/orders.service.ts` — **create.** `placeOrder`, `getOrder`, `markOrderPaid`, `fulfillOrder`, `cancelOrder`, DTO mapping, `OrderError`.
- `src/orders/orders.routes.ts` — **create.** `POST /api/v1/orders`, `GET /api/v1/orders/:id`.
- `prisma/schema.prisma` — **modify.** Add `OrderStatus` enum, `Order`, `OrderLine`; add `orderLines OrderLine[]` back-relation to `Variant`.
- `src/app.ts` — **modify.** Mount `ordersRouter` at `/api/v1/orders`.
- `tests/helpers/db.ts` — **modify.** Add `orderLine`, `order` to `resetDb()` (before `variant`).
- Tests (create): `tests/tax.test.ts`, `tests/orders-schema.test.ts`, `tests/orders-service.test.ts`, `tests/orders-transitions.test.ts`, `tests/orders-api.test.ts`.

---

### Task 1: Tax port + flat-rate Michigan adapter

Pure, no DB. Defines the boundary the order service will depend on. Owns its own files entirely, so it can run in parallel with Task 2.

**Files:**
- Create: `src/ports/tax/tax.port.ts`
- Create: `src/ports/tax/flat-rate.adapter.ts`
- Test: `tests/tax.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface TaxInput { shipToState: string; lineItems: { amountCents: number }[] }`
  - `interface TaxResult { taxCents: number; rateBps: number; jurisdiction: string }`
  - `interface TaxPort { computeTax(input: TaxInput): Promise<TaxResult> }`
  - `function createFlatRateTaxPort(rates?: Record<string, number>): TaxPort`
  - `const NEXUS_RATES_BPS: Record<string, number>` (default `{ MI: 600 }`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/tax.test.ts
import { describe, it, expect } from 'vitest'
import { createFlatRateTaxPort, NEXUS_RATES_BPS } from '../src/ports/tax/flat-rate.adapter.js'

describe('flat-rate tax port', () => {
  const tax = createFlatRateTaxPort()

  it('charges Michigan 6% on the subtotal, rounded to the nearest cent', async () => {
    const r = await tax.computeTax({ shipToState: 'MI', lineItems: [{ amountCents: 4999 }] })
    expect(r.taxCents).toBe(300)      // 4999 * 600 / 10000 = 299.94 -> 300
    expect(r.rateBps).toBe(600)
    expect(r.jurisdiction).toBe('MI')
  })

  it('sums multiple line items before applying the rate', async () => {
    const r = await tax.computeTax({ shipToState: 'mi', lineItems: [{ amountCents: 1000 }, { amountCents: 2000 }] })
    expect(r.taxCents).toBe(180)      // 3000 * 6%
  })

  it('charges zero tax for a non-nexus state', async () => {
    const r = await tax.computeTax({ shipToState: 'CA', lineItems: [{ amountCents: 5000 }] })
    expect(r.taxCents).toBe(0)
    expect(r.rateBps).toBe(0)
    expect(r.jurisdiction).toBe('none')
  })

  it('exposes Michigan as the only default nexus state', () => {
    expect(NEXUS_RATES_BPS).toEqual({ MI: 600 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tax.test.ts`
Expected: FAIL — cannot resolve `../src/ports/tax/flat-rate.adapter.js`.

- [ ] **Step 3: Write the port interface**

```ts
// src/ports/tax/tax.port.ts
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
```

- [ ] **Step 4: Write the flat-rate adapter**

```ts
// src/ports/tax/flat-rate.adapter.ts
import type { TaxInput, TaxPort, TaxResult } from './tax.port.js'

// Nexus states and their sales-tax rate in integer basis points (600 = 6.00%).
// Michigan is AlpineBrick's only nexus state at Phase 1.
export const NEXUS_RATES_BPS: Record<string, number> = { MI: 600 }

export function createFlatRateTaxPort(rates: Record<string, number> = NEXUS_RATES_BPS): TaxPort {
  return {
    async computeTax(input: TaxInput): Promise<TaxResult> {
      const state = input.shipToState.trim().toUpperCase()
      const rateBps = rates[state] ?? 0
      const subtotalCents = input.lineItems.reduce((sum, li) => sum + li.amountCents, 0)
      const taxCents = Math.round((subtotalCents * rateBps) / 10000)
      return { taxCents, rateBps, jurisdiction: rateBps > 0 ? state : 'none' }
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/tax.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/tax/tax.port.ts src/ports/tax/flat-rate.adapter.ts tests/tax.test.ts
git commit -m "feat(core): add Tax port with flat nexus-rate adapter (Michigan 6%)"
```

---

### Task 2: Order + OrderLine schema and migration

Adds the persistence layer. Independent of Task 1 (different files), so the two can run in the same Ringer round.

**Files:**
- Modify: `prisma/schema.prisma` (add enum + two models + one back-relation)
- Modify: `tests/helpers/db.ts` (extend `resetDb`)
- Create migration: `prisma/migrations/<timestamp>_add_orders/migration.sql` (generated)
- Test: `tests/orders-schema.test.ts`

**Interfaces:**
- Consumes: existing `Variant`, `Inventory` models.
- Produces (Prisma models other tasks rely on):
  - `Order { id, number(Int, unique, autoincrement), status(OrderStatus), email, shipToState, subtotalCents, taxCents, totalCents, taxRateBps, taxJurisdiction, createdAt, updatedAt, lines OrderLine[] }`
  - `OrderLine { id, orderId, variantId, sku, quantity, unitPriceCents, lineSubtotalCents }`
  - `enum OrderStatus { pending paid fulfilled cancelled }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/orders-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('order schema', () => {
  it('persists an order with lines and defaults to pending', async () => {
    const variant = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const order = await prisma.order.create({
      data: {
        email: 'buyer@example.com', shipToState: 'MI',
        subtotalCents: 4999, taxCents: 300, totalCents: 5299,
        taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [{
          variantId: variant.id, sku: variant.sku, quantity: 1,
          unitPriceCents: 4999, lineSubtotalCents: 4999,
        }] },
      },
      include: { lines: true },
    })
    expect(order.status).toBe('pending')
    expect(order.number).toBeGreaterThan(0)
    expect(order.lines).toHaveLength(1)
    expect(order.totalCents).toBe(5299)
  })

  it('cascade-deletes lines when the order is deleted', async () => {
    const variant = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const order = await prisma.order.create({
      data: {
        email: 'x@example.com', shipToState: 'MI',
        subtotalCents: 4999, taxCents: 300, totalCents: 5299, taxRateBps: 600, taxJurisdiction: 'MI',
        lines: { create: [{ variantId: variant.id, sku: variant.sku, quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }] },
      },
    })
    await prisma.order.delete({ where: { id: order.id } })
    expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(0)
  })
})
```

- [ ] **Step 2: Extend `resetDb` so this and every other test can reset cleanly**

```ts
// tests/helpers/db.ts
import { prisma } from '../../src/prisma.js'

export async function resetDb() {
  // Order matters: children before parents.
  await prisma.auditLog.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.order.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.variant.deleteMany()
  await prisma.product.deleteMany()
  await prisma.actor.deleteMany()
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/orders-schema.test.ts`
Expected: FAIL — `prisma.order` is undefined / property `order` does not exist on the client.

- [ ] **Step 4: Add the models to the schema**

Add to `prisma/schema.prisma` (after the existing `enum ActorType` block, keep other enums intact):

```prisma
enum OrderStatus {
  pending
  paid
  fulfilled
  cancelled
}
```

Add the `orderLines` back-relation to the existing `Variant` model (add this one line inside the model, alongside `inventory`):

```prisma
  orderLines OrderLine[]
```

Append the two new models:

```prisma
model Order {
  id              String      @id @default(cuid())
  number          Int         @unique @default(autoincrement())
  status          OrderStatus @default(pending)
  email           String
  shipToState     String      @map("ship_to_state")
  subtotalCents   Int         @map("subtotal_cents")
  taxCents        Int         @map("tax_cents")
  totalCents      Int         @map("total_cents")
  taxRateBps      Int         @map("tax_rate_bps")
  taxJurisdiction String      @map("tax_jurisdiction")
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  lines           OrderLine[]
  @@map("orders")
}

model OrderLine {
  id                String  @id @default(cuid())
  orderId           String  @map("order_id")
  order             Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  variantId         String  @map("variant_id")
  variant           Variant @relation(fields: [variantId], references: [id], onDelete: Restrict)
  sku               String
  quantity          Int
  unitPriceCents    Int     @map("unit_price_cents")
  lineSubtotalCents Int     @map("line_subtotal_cents")
  @@index([orderId])
  @@index([variantId])
  @@map("order_lines")
}
```

- [ ] **Step 5: Generate the migration and client**

Run: `npx prisma migrate dev --name add_orders`
Expected: creates `prisma/migrations/<timestamp>_add_orders/migration.sql` with `CREATE TABLE "orders"`, `CREATE TABLE "order_lines"`, `CREATE TYPE "OrderStatus"`, and regenerates the Prisma client. Output ends with `Your database is now in sync with your schema.`

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/orders-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/helpers/db.ts tests/orders-schema.test.ts
git commit -m "feat(core): add Order and OrderLine models with add_orders migration"
```

---

### Task 3: Order service — `placeOrder` (tax + atomic reserve) and `getOrder`

The revenue-loop core. Depends on Task 1 (tax port) and Task 2 (schema). Reservation uses a race-safe conditional `UPDATE` so two concurrent orders cannot both consume the last unit.

**Files:**
- Create: `src/orders/orders.service.ts`
- Test: `tests/orders-service.test.ts`

**Interfaces:**
- Consumes: `createFlatRateTaxPort`, `TaxPort` (Task 1); `prisma`; `recordAudit`; `Order`/`OrderLine`/`Variant`/`Inventory` (Task 2).
- Produces:
  - `class OrderError extends Error { code: string }`
  - `interface OrderDto { id; orderNumber; status; email; shipToState; subtotalCents; taxCents; totalCents; taxRateBps; taxJurisdiction; lines: { variantId; sku; quantity; unitPriceCents; lineSubtotalCents }[] }`
  - `function placeOrder(input: { email: string; shipToState: string; lines: { variantId: string; quantity: number }[]; actorId?: string }, taxPort?: TaxPort): Promise<OrderDto>`
  - `function getOrder(id: string): Promise<OrderDto | null>`
  - `function orderNumber(n: number): string` → `"IB-000001"`

- [ ] **Step 1: Write the failing test**

```ts
// tests/orders-service.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, getOrder, OrderError } from '../src/orders/orders.service.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function variantId(sku: string) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return v.id
}

describe('placeOrder', () => {
  it('creates a pending order, computes Michigan tax, and reserves stock', async () => {
    const vid = await variantId('BBS-STD') // priceCents 4999, onHand 25
    const order = await placeOrder({ email: 'buyer@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 2 }] })

    expect(order.status).toBe('pending')
    expect(order.orderNumber).toMatch(/^IB-\d{6}$/)
    expect(order.subtotalCents).toBe(9998)
    expect(order.taxCents).toBe(600)          // 9998 * 6% = 599.88 -> 600
    expect(order.totalCents).toBe(10598)

    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(2)
    expect(inv.onHand).toBe(25)               // on_hand unchanged until fulfillment
  })

  it('charges no tax when shipping outside a nexus state', async () => {
    const vid = await variantId('BBS-STD')
    const order = await placeOrder({ email: 'b@example.com', shipToState: 'CA', lines: [{ variantId: vid, quantity: 1 }] })
    expect(order.taxCents).toBe(0)
    expect(order.totalCents).toBe(4999)
  })

  it('rejects an order that exceeds available stock and reserves nothing', async () => {
    const vid = await variantId('CMP-LTD') // onHand 8
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 9 }] }))
      .rejects.toMatchObject({ code: 'insufficient_stock' })
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: vid } })
    expect(inv.reserved).toBe(0)
  })

  it('rejects a line for a non-published or unknown variant', async () => {
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: 'does-not-exist', quantity: 1 }] }))
      .rejects.toBeInstanceOf(OrderError)
  })

  it('rejects an empty order and a non-positive quantity', async () => {
    const vid = await variantId('BBS-STD')
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [] })).rejects.toMatchObject({ code: 'empty_order' })
    await expect(placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 0 }] }))
      .rejects.toMatchObject({ code: 'invalid_quantity' })
  })

  it('writes an order.place audit row', async () => {
    const vid = await variantId('BBS-STD')
    const order = await placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const audit = await prisma.auditLog.findFirst({ where: { action: 'order.place', target: `order:${order.id}` } })
    expect(audit).not.toBeNull()
  })

  it('getOrder returns the persisted order or null', async () => {
    const vid = await variantId('BBS-STD')
    const placed = await placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const fetched = await getOrder(placed.id)
    expect(fetched?.id).toBe(placed.id)
    expect(await getOrder('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orders-service.test.ts`
Expected: FAIL — cannot resolve `../src/orders/orders.service.js`.

- [ ] **Step 3: Write the service**

```ts
// src/orders/orders.service.ts
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import { createFlatRateTaxPort } from '../ports/tax/flat-rate.adapter.js'

export class OrderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

export interface OrderLineDto {
  variantId: string
  sku: string
  quantity: number
  unitPriceCents: number
  lineSubtotalCents: number
}

export interface OrderDto {
  id: string
  orderNumber: string
  status: string
  email: string
  shipToState: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  taxRateBps: number
  taxJurisdiction: string
  lines: OrderLineDto[]
}

export interface PlaceOrderInput {
  email: string
  shipToState: string
  lines: { variantId: string; quantity: number }[]
  actorId?: string
}

const defaultTaxPort = createFlatRateTaxPort()

export function orderNumber(n: number): string {
  return `IB-${String(n).padStart(6, '0')}`
}

function toDto(o: any): OrderDto {
  return {
    id: o.id,
    orderNumber: orderNumber(o.number),
    status: o.status,
    email: o.email,
    shipToState: o.shipToState,
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    taxRateBps: o.taxRateBps,
    taxJurisdiction: o.taxJurisdiction,
    lines: o.lines.map((l: any) => ({
      variantId: l.variantId, sku: l.sku, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
    })),
  }
}

export async function placeOrder(input: PlaceOrderInput, taxPort: TaxPort = defaultTaxPort): Promise<OrderDto> {
  if (input.lines.length === 0) throw new OrderError('empty_order', 'order must have at least one line')
  const actorId = input.actorId ?? 'system'

  const order = await prisma.$transaction(async (tx) => {
    // 1. Resolve every line against a published variant; snapshot price + sku.
    const resolved: { variantId: string; sku: string; quantity: number; unitPriceCents: number }[] = []
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new OrderError('invalid_quantity', `quantity must be a positive integer for variant ${line.variantId}`)
      }
      const variant = await tx.variant.findFirst({
        where: { id: line.variantId, product: { status: 'published' } },
      })
      if (!variant) throw new OrderError('variant_not_found', `no published variant ${line.variantId}`)
      resolved.push({ variantId: variant.id, sku: variant.sku, quantity: line.quantity, unitPriceCents: variant.priceCents })
    }

    // 2. Reserve each line atomically: only reserve if enough is available RIGHT NOW.
    for (const line of resolved) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${line.variantId} AND on_hand - reserved >= ${line.quantity}`
      if (affected === 0) throw new OrderError('insufficient_stock', `not enough stock for variant ${line.variantId}`)
    }

    // 3. Compute money from the snapshot; tax comes from the port.
    const subtotalCents = resolved.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0)
    const tax = await taxPort.computeTax({
      shipToState: input.shipToState,
      lineItems: resolved.map((l) => ({ amountCents: l.unitPriceCents * l.quantity })),
    })

    return tx.order.create({
      data: {
        email: input.email,
        shipToState: input.shipToState.trim().toUpperCase(),
        status: 'pending',
        subtotalCents,
        taxCents: tax.taxCents,
        totalCents: subtotalCents + tax.taxCents,
        taxRateBps: tax.rateBps,
        taxJurisdiction: tax.jurisdiction,
        lines: {
          create: resolved.map((l) => ({
            variantId: l.variantId, sku: l.sku, quantity: l.quantity,
            unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.unitPriceCents * l.quantity,
          })),
        },
      },
      include: { lines: true },
    })
  })

  await recordAudit({
    actorId, action: 'order.place', target: `order:${order.id}`,
    after: { status: order.status, totalCents: order.totalCents },
  })
  return toDto(order)
}

export async function getOrder(id: string): Promise<OrderDto | null> {
  const o = await prisma.order.findUnique({ where: { id }, include: { lines: true } })
  return o ? toDto(o) : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orders-service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orders/orders.service.ts tests/orders-service.test.ts
git commit -m "feat(core): placeOrder with port-computed tax and atomic stock reservation"
```

---

### Task 4: Order state transitions — `markOrderPaid`, `fulfillOrder`, `cancelOrder`

The order lifecycle: `pending → paid → fulfilled`, with `cancel` from `pending`/`paid`. Fulfillment decrements `on_hand` and clears the `reserved` hold; cancellation releases the hold. `markOrderPaid` is the seam Plan 3 (Stripe) will call. Depends on Task 3 (extends `orders.service.ts`). Different files from Task 5, so the two can share a Ringer round once Task 3 is applied.

**Files:**
- Modify: `src/orders/orders.service.ts` (append the three transition functions)
- Test: `tests/orders-transitions.test.ts`

**Interfaces:**
- Consumes: `placeOrder`, `OrderError`, `toDto`, `prisma`, `recordAudit` (Task 3).
- Produces:
  - `function markOrderPaid(orderId: string, actorId?: string): Promise<OrderDto>` — `pending → paid`; no inventory change.
  - `function fulfillOrder(orderId: string, actorId?: string): Promise<OrderDto>` — `paid → fulfilled`; `on_hand -= qty`, `reserved -= qty` per line.
  - `function cancelOrder(orderId: string, actorId?: string): Promise<OrderDto>` — `pending|paid → cancelled`; `reserved -= qty` per line.
  - Invalid transitions throw `OrderError` with code `invalid_transition`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orders-transitions.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, markOrderPaid, fulfillOrder, cancelOrder } from '../src/orders/orders.service.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function place(sku: string, qty: number) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: qty }] })
}

describe('order transitions', () => {
  it('fulfilling a paid order decrements on_hand and releases the reservation', async () => {
    const order = await place('BBS-STD', 3) // onHand 25 -> reserved 3
    await markOrderPaid(order.id)
    const done = await fulfillOrder(order.id)
    expect(done.status).toBe('fulfilled')
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })
    expect(inv.onHand).toBe(22)
    expect(inv.reserved).toBe(0)
  })

  it('cancelling a pending order releases the reservation without touching on_hand', async () => {
    const order = await place('BBS-STD', 4)
    const cancelled = await cancelOrder(order.id)
    expect(cancelled.status).toBe('cancelled')
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variant: { sku: 'BBS-STD' } } })
    expect(inv.onHand).toBe(25)
    expect(inv.reserved).toBe(0)
  })

  it('refuses to fulfill an order that is not paid', async () => {
    const order = await place('BBS-STD', 1) // still pending
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('refuses to cancel a fulfilled order', async () => {
    const order = await place('BBS-STD', 1)
    await markOrderPaid(order.id)
    await fulfillOrder(order.id)
    await expect(cancelOrder(order.id)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('writes audit rows for each transition', async () => {
    const order = await place('BBS-STD', 1)
    await markOrderPaid(order.id)
    await fulfillOrder(order.id)
    const actions = (await prisma.auditLog.findMany({ where: { target: `order:${order.id}` } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['order.place', 'order.paid', 'order.fulfilled']))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orders-transitions.test.ts`
Expected: FAIL — `markOrderPaid`/`fulfillOrder`/`cancelOrder` are not exported.

- [ ] **Step 3: Append the transition functions to `orders.service.ts`**

```ts
// --- append to src/orders/orders.service.ts ---

async function loadOrderForUpdate(tx: any, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  return order
}

export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending') {
      throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'paid' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.paid', target: `order:${orderId}`, before: { status: 'pending' }, after: { status: 'paid' } })
  return toDto(updated)
}

export async function fulfillOrder(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot fulfill a ${order.status} order`)
    }
    for (const line of order.lines) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET on_hand = on_hand - ${line.quantity}, reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity} AND on_hand >= ${line.quantity}`
      if (affected === 0) throw new OrderError('inventory_conflict', `cannot decrement stock for variant ${line.variantId}`)
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'fulfilled' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.fulfilled', target: `order:${orderId}`, before: { status: 'paid' }, after: { status: 'fulfilled' } })
  return toDto(updated)
}

export async function cancelOrder(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending' && order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot cancel a ${order.status} order`)
    }
    for (const line of order.lines) {
      await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'cancelled' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.cancelled', target: `order:${orderId}`, after: { status: 'cancelled' } })
  return toDto(updated)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orders-transitions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orders/orders.service.ts tests/orders-transitions.test.ts
git commit -m "feat(core): order lifecycle transitions (paid/fulfill/cancel) with inventory effects"
```

---

### Task 5: HTTP surface — `POST /api/v1/orders`, `GET /api/v1/orders/:id`

Exposes the checkout entry point. Depends on Task 3 (uses `placeOrder`/`getOrder`). Different files from Task 4, so it can share a Ringer round with Task 4 once Task 3 is applied. Transition routes (pay/fulfill/cancel) are intentionally deferred to their owning plans (Payments = Plan 3, Fulfillment = Plan 6); Plan 2 ships only the create + read surface.

**Files:**
- Create: `src/orders/orders.routes.ts`
- Modify: `src/app.ts` (mount the router)
- Test: `tests/orders-api.test.ts`

**Interfaces:**
- Consumes: `placeOrder`, `getOrder`, `OrderError` (Task 3); `buildApp` (existing).
- Produces: `export const ordersRouter: Router`.
  - `POST /api/v1/orders` body `{ email, shipToState, lines: [{ variantId, quantity }] }` → `201` + `OrderDto`; `400` + `{ error: <code> }` on `OrderError`.
  - `GET /api/v1/orders/:id` → `200` + `OrderDto` or `404` + `{ error: 'not_found' }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orders-api.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { buildApp } from '../src/app.js'

const app = buildApp()
beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function variantId(sku: string) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return v.id
}

describe('orders API', () => {
  it('places an order and returns 201 with computed totals', async () => {
    const vid = await variantId('BBS-STD')
    const res = await request(app).post('/api/v1/orders')
      .send({ email: 'buyer@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending')
    expect(res.body.taxCents).toBe(300)
    expect(res.body.totalCents).toBe(5299)
  })

  it('returns 400 with the error code when stock is insufficient', async () => {
    const vid = await variantId('CMP-LTD') // onHand 8
    const res = await request(app).post('/api/v1/orders')
      .send({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 99 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('insufficient_stock')
  })

  it('gets an order by id and 404s for an unknown id', async () => {
    const vid = await variantId('BBS-STD')
    const placed = await request(app).post('/api/v1/orders')
      .send({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const got = await request(app).get(`/api/v1/orders/${placed.body.id}`)
    expect(got.status).toBe(200)
    expect(got.body.id).toBe(placed.body.id)
    expect((await request(app).get('/api/v1/orders/nope')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orders-api.test.ts`
Expected: FAIL — `POST /api/v1/orders` returns 404 (route not mounted).

- [ ] **Step 3: Write the router**

```ts
// src/orders/orders.routes.ts
import { Router } from 'express'
import { placeOrder, getOrder, OrderError } from './orders.service.js'

export const ordersRouter = Router()

ordersRouter.post('/', async (req, res) => {
  const body = req.body ?? {}
  if (typeof body.email !== 'string' || typeof body.shipToState !== 'string' || !Array.isArray(body.lines)) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  try {
    const order = await placeOrder({ email: body.email, shipToState: body.shipToState, lines: body.lines })
    res.status(201).json(order)
  } catch (err) {
    if (err instanceof OrderError) return res.status(400).json({ error: err.code })
    throw err
  }
})

ordersRouter.get('/:id', async (req, res) => {
  const order = await getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  res.json(order)
})
```

- [ ] **Step 4: Mount the router in `app.ts`**

```ts
// src/app.ts
import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { ordersRouter } from './orders/orders.routes.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/v1/catalog', catalogRouter)
  app.use('/api/v1/orders', ordersRouter)
  return app
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/orders-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all Plan 1 tests plus the new Plan 2 tests green.

- [ ] **Step 7: Commit**

```bash
git add src/orders/orders.routes.ts src/app.ts tests/orders-api.test.ts
git commit -m "feat(core): expose POST/GET /api/v1/orders"
```

---

## Execution & Ringer batching

Task dependency graph (→ means "must be applied before"):

```
Task 1 (tax port) ─┐
                   ├─► Task 3 (service) ─┬─► Task 4 (transitions)
Task 2 (schema) ───┘                     └─► Task 5 (routes)
```

Mapped to Ringer rounds under one run_name `plan2-orders-inventory-tax` (worktree
isolation, patch export, review-and-apply between rounds):

- **Round A:** Task 1 + Task 2 in parallel (disjoint files, no shared deps). Apply both patches to `design/platform-redesign`, review, run `npm test`.
- **Round B:** Task 3 alone (needs Task 1 + Task 2 applied). Apply, review.
- **Round C:** Task 4 + Task 5 in parallel (both need Task 3; disjoint files — Task 4 edits `orders.service.ts`, Task 5 creates `orders.routes.ts` + edits `app.ts`). Apply, review, run full `npm test`.

**Open execution-infra items to resolve when building the manifests (not blockers to the plan):**
- Each worktree worker needs `node_modules` (fresh worktrees omit gitignored dirs), a generated Prisma client, and a reachable Postgres. The check must provision these — install deps, `prisma generate`, and point `DATABASE_URL` at an **isolated database per task** (separate DB name or container) so parallel Round-A/Round-C workers don't collide on one shared `alpinebrick-core-db`.
- Migrations: the Task 2 worker runs `prisma migrate dev`; downstream rounds run `prisma migrate deploy` against their isolated DB before tests.

## Self-Review

- **Spec coverage:** Tax port + Michigan adapter (T1) ✓; Order/OrderLine persistence + reservation columns already exist, extended (T2) ✓; reserve-on-order (T3) ✓; decrement-on-fulfillment + release-on-cancel (T4) ✓; checkout HTTP entry (T5) ✓; audit on every transition (T3, T4) ✓; money in integer cents / tax in basis points (Global Constraints, all tasks) ✓; published-only order lines (T3) ✓.
- **Placeholders:** none — every step carries real code and exact commands.
- **Type consistency:** `TaxPort.computeTax` signature identical across T1/T3; `OrderDto`/`OrderError`/`orderNumber` defined in T3 and reused unchanged in T4/T5; Prisma field names (`number`, `reserved`, `onHand`, `shipToState`) consistent between schema (T2) and consumers (T3–T5).
- **Deferred by design (not gaps):** payment provider + `order.paid` HTTP route → Plan 3; operator fulfillment queue + fulfill/cancel routes → Plan 6; customer identity on orders (currently `email` + `system` actor) → Plan 4.
```

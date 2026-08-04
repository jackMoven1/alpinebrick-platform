# ImagiBrick Core

Modular-monolith core (TypeScript + Express + Prisma/Postgres). Phase 1 substrate:
canonical schema (catalog + audit slice), seed, and the read-only catalog API at
`/api/v1/catalog`.

## Dev
1. `docker run -d --name alpinebrick-core-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:15`
2. `cp .env.example .env`
3. `npm install && npx prisma migrate dev && npm run seed`
4. `npm run dev` → http://localhost:4000/health

## Supersedes
`systems/catalog-service` (read-only Postgres API) is replaced by this module's
catalog API. Do not add features to `catalog-service`; it will be removed once the
storefront (Plan 5) points at `/api/v1/catalog` here.

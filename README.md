# AlpineBrick Engineering Workspace

This repository contains independent service projects for the AlpineBrick platform.

## Projects
- `contracts/` — shared API and event contract definitions
- `systems/catalog-service/code/` — product catalog service
- `systems/order-service/code/` — checkout and order processing service
- `systems/inventory-service/code/` — inventory management service
- `systems/affiliate-service/code/` — affiliate marketing service
- `systems/storefront/code/` — customer-facing storefront application
- `systems/catalog-admin/code/` — back-office product catalog management UI

## Getting started
1. Install dependencies from the repo root.
   ```bash
   npm install
   ```
2. Run service-specific startup commands from the individual project directories.
   ```bash
   cd systems/catalog-service/code
   npm run dev
   ```
   ```bash
   cd systems/storefront/code
   npm run dev
   ```
3. Keep contract changes in `contracts/` and update dependent projects with the local package reference.

## Local development with Docker Compose
1. Build and launch all services:
   ```bash
   docker compose up --build
   ```
2. Access services on:
   - `http://localhost:3000` — storefront
   - `http://localhost:3001` — catalog admin
   - `http://localhost:4001` — catalog service
   - `http://localhost:4002` — order service
   - `http://localhost:4003` — inventory service
   - `http://localhost:4004` — affiliate service

## Local deployment batch
From the repo root, run:
```powershell
.\deploy.bat
```
This installs dependencies, runs repo tests, stops any existing containers, and brings all services up via Docker Compose.

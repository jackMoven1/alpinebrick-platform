# ImagiBricks Repository Layout Proposal

## Goal
Support independent project ownership for each system while keeping integration contracts and shared tooling centralized.

## Proposed repository layout

```
engineering/
├── .claude/
│   └── agents/
│       ├── engineering-lead.md
│       ├── agent-plan.md
│       └── ...
├── .claude/
│   └── agents/
│       ├── engineering-lead.md
│       ├── agent-plan.md
│       └── ...
├── contracts/
│   ├── README.md
│   ├── openapi/
│   │   ├── catalog.yaml
│   │   ├── inventory.yaml
│   │   ├── order.yaml
│   │   └── affiliate.yaml
│   ├── events/
│   │   ├── order.events.json
│   │   ├── inventory.events.json
│   │   └── affiliate.events.json
│   └── package.json
├── systems/
│   ├── catalog-service/
│   │   ├── code/
│   │   │   ├── src/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── README.md
│   │   └── docs/
│   ├── inventory-service/
│   │   ├── code/
│   │   │   ├── src/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── README.md
│   │   └── docs/
│   ├── order-service/
│   │   ├── code/
│   │   │   ├── src/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── README.md
│   │   └── docs/
│   ├── affiliate-service/
│   │   ├── code/
│   │   │   ├── src/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── README.md
│   │   └── docs/
│   ├── storefront/
│   │   ├── code/
│   │   │   ├── src/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── README.md
│   │   └── docs/
│   └── catalog-admin/
│       ├── code/
│       │   ├── src/
│       │   ├── Dockerfile
│       │   ├── package.json
│       │   └── README.md
│       └── docs/
├── shared-docs/
│   ├── SYSTEM-ARCHITECTURE.md
│   ├── CONTRACTS.md
│   └── REPO-LAYOUT.md
└── README.md
```

## Notes on the layout
- `contracts/` is the shared integration package for API schemas, DTOs, and event definitions.
- Each service directory is an independent project with its own code, tests, and deployment artifacts.
- `storefront/` is the customer-facing site; `catalog-admin/` is the back-office interface for product management.
- `docs/` houses architecture, contract, and repo guidance.
- A top-level `README.md` describes the monorepo structure and development workflow.

## Independent project management
Each project should own:
- its own `package.json` / dependencies
- its own `Dockerfile` or deployment manifest
- its own test suite and CI validation
- its own README with local startup instructions
- versioned API contract references from `contracts/`

## Shared tooling and cross-project support
- Keep shared build/test scripts in a top-level `scripts/` directory if needed.
- Keep shared TypeScript types and generated clients in `contracts/`.
- Use root-level CI workflows to run per-project validation and contract checks.
- Use a `package.json` or `pnpm-workspace.yaml` at the repo root if using a JavaScript monorepo tool to ease dependency management.

## Deployment recommendation
- Each service can deploy independently, as long as contract versions are compatible.
- Use an API gateway or service proxy to route storefront and internal API calls.
- Use a shared database only if the team chooses a monolith-to-modular transition path; otherwise each service can own its own schema and share via integration events.

## First-phase implementation
1. Create `contracts/` and define the first OpenAPI/event schemas.
2. Scaffold `catalog-service/`, `order-service/`, and `storefront/` as the MVP core.
3. Add `inventory-service/` and `affiliate-service/` once the order/checkout path is stable.
4. Add `catalog-admin/` in parallel with the product authoring workflow.

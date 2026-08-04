# Shared Documentation

**Cross-cutting docs for the AlpineBrick platform**

---

## 📚 Core Platform Docs

### [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md)
**Platform topology & service interactions**
- All services and their relationships
- Data flow diagrams
- Deployment architecture
- External service integrations (Stripe, etc.)

### [REPO-LAYOUT.md](./REPO-LAYOUT.md)
**Monorepo structure & conventions**
- Directory organization
- Service layout
- Shared code patterns
- Dockerfile locations

### [CONTRACTS.md](./CONTRACTS.md)
**API contracts between services**
- Order Service ↔ Catalog Service
- Order Service ↔ Inventory Service
- Storefront ↔ All services
- Event schema for tracking

### [DEPLOYMENT.md](./DEPLOYMENT.md)
**Docker & local environment setup**
- docker-compose.yaml reference
- Environment variables
- Database initialization
- Local dev getting started

### [CONVENTIONS.md](./CONVENTIONS.md)
**Engineering standards & practices**
- Git workflow (branch + PR)
- Code review expectations
- Naming conventions
- Error handling patterns
- Logging standards

---

## 📋 Additional Shared Docs

### [GLOSSARY.md](./GLOSSARY.md)
**Shared terminology**
- Product / Variant / SKU definitions
- Order states & terminology
- Affiliate commission model
- Event types

### [INFRASTRUCTURE.md](./INFRASTRUCTURE.md)
**Infrastructure & DevOps**
- Docker Compose services
- Volume management
- Network configuration
- Production deployment (future)

---

## 🔍 Quick Navigation

**I want to...**
- **Understand how services talk to each other** → [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md)
- **Set up local dev environment** → [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Learn API contracts** → [CONTRACTS.md](./CONTRACTS.md)
- **Check git/PR workflow** → [CONVENTIONS.md](./CONVENTIONS.md)
- **Find a service** → [REPO-LAYOUT.md](./REPO-LAYOUT.md)
- **Understand terms** → [GLOSSARY.md](./GLOSSARY.md)

---

## 📂 System-Specific Docs

Each system has its own `/docs/` folder:
- `systems/catalog-admin/docs/` – Catalog admin specs & architecture
- `systems/storefront/docs/` – Storefront decisions & progress
- `systems/catalog-service/docs/` – API reference
- `systems/order-service/docs/` – (TBD)
- `systems/affiliate-service/docs/` – (TBD)
- etc.

---

**Last Updated**: June 3, 2026  
**Maintained By**: Engineering Lead

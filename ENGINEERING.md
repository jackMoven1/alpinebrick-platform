# ImagiBricks Engineering – Directory Structure

**Date**: June 3, 2026  
**Status**: Active reorganization for clarity and scale

---

## 📁 Structure Overview

```
engineering/
├─ systems/                          ← Each major system in its own dir
│  ├─ catalog-admin/
│  │  ├─ docs/                       ← Specs, ADRs, architecture
│  │  └─ hiring/                     ← Job posts, hiring briefs
│  ├─ catalog-service/
│  │  └─ docs/
│  ├─ storefront/
│  │  ├─ docs/
│  │  └─ hiring/
│  ├─ order-service/
│  │  └─ docs/
│  ├─ inventory-service/
│  │  └─ docs/
│  ├─ affiliate-service/
│  │  └─ docs/
│  ├─ interaction-tracking/
│  │  └─ docs/
│  └─ mcp-integration/
│     └─ docs/
├─ shared-docs/                      ← Cross-system documentation
├─ .agents/                          ← Agent configuration files
├─ systems/catalog-admin/code/       ← Service code
├─ systems/catalog-service/code/     ← Service code
├─ systems/storefront/code/          ← Service code
├─ systems/order-service/code/       ← Service code
├─ systems/inventory-service/code/   ← Service code
├─ systems/affiliate-service/code/   ← Service code
├─ contracts/                        ← Shared API contracts
├─ docker-compose.yaml               ← Local dev environment
├─ pnpm-workspace.yaml               ← Monorepo config
├─ package.json                      ← Root package
└─ ENGINEERING.md                    ← This file (entry point)
```

---

## 📋 What Goes Where

### `/systems/[SYSTEM-NAME]/docs/`
System-specific documentation:
- **SPEC.md** – Technical specification (what to build)
- **ADR-*.md** – Architecture Decision Records (why we chose this)
- **IMPLEMENTATION-STATUS.md** – Progress tracking
- **API.md** – API reference (if service exposes APIs)
- **DATABASE.md** – Schema & migrations

### `/systems/[SYSTEM-NAME]/hiring/`
Everything related to hiring for that system:
- **JOB-POSTING.md** – Role description for job boards
- **HIRING-BRIEF.md** – Internal hiring brief for HR
- **TECHNICAL-ASSESSMENT.md** – Interview & coding challenge

### `/shared-docs/`
Cross-cutting documentation:
- **SYSTEM-ARCHITECTURE.md** – Overall platform topology
- **REPO-LAYOUT.md** – Monorepo structure & conventions
- **CONTRACTS.md** – API contracts between services
- **DEPLOYMENT.md** – Docker Compose & environment setup
- **CONVENTIONS.md** – Naming, git workflow, PR standards
- **GLOSSARY.md** – Shared terminology

### `/.agents/`
Agent configuration & instructions:
- **engineering-lead.md** – Engineering Lead agent
- **storefront-engineer.md** – Storefront Engineer agent
- **catalog-developer.md** – Catalog Admin developer (when hired)

---

## 🗂️ Current Systems & Status

| System | Service | Status | Owner | Docs | Hiring |
|--------|---------|--------|-------|------|--------|
| **Catalog Service** | `systems/catalog-service/code/` | ✅ MVP | Built | [docs](./systems/catalog-service/docs/) | N/A |
| **Catalog Admin** | `systems/catalog-admin/code/` | 📋 Spec | Pending dev | [docs](./systems/catalog-admin/docs/) | [hiring](./systems/catalog-admin/hiring/) |
| **Storefront** | `systems/storefront/code/` | 🚀 Sprint 1 | Storefront Eng | [docs](./systems/storefront/docs/) | ✅ Hired |
| **Order Service** | `systems/order-service/code/` | 🔳 Placeholder | Pending | [docs](./systems/order-service/docs/) | TBD |
| **Inventory Service** | `systems/inventory-service/code/` | 🔳 Placeholder | Pending | [docs](./systems/inventory-service/docs/) | TBD |
| **Affiliate Service** | `systems/affiliate-service/code/` | 🔳 Placeholder | Pending | [docs](./systems/affiliate-service/docs/) | TBD |
| **Interaction Tracking** | N/A (TBD) | 🔳 Planned | Pending | [docs](./systems/interaction-tracking/docs/) | TBD |
| **MCP Integration** | N/A (TBD) | 🔳 Planned | Pending | [docs](./systems/mcp-integration/docs/) | TBD |

---

## 🔍 Finding What You Need

**I want to...**

- **Understand the order processing flow** → [shared-docs/SYSTEM-ARCHITECTURE.md](./shared-docs/SYSTEM-ARCHITECTURE.md)
- **Review catalog-admin tech spec** → [systems/catalog-admin/docs/SPEC.md](./systems/catalog-admin/docs/)
- **Read storefront architecture decisions** → [systems/storefront/docs/](./systems/storefront/docs/)
- **Hire a catalog developer** → [systems/catalog-admin/hiring/](./systems/catalog-admin/hiring/)
- **Understand API contracts** → [shared-docs/CONTRACTS.md](./shared-docs/CONTRACTS.md)
- **Set up local dev environment** → [shared-docs/DEPLOYMENT.md](./shared-docs/DEPLOYMENT.md)
- **Check engineering conventions** → [shared-docs/CONVENTIONS.md](./shared-docs/CONVENTIONS.md)

---

## 🚀 How to Use This Structure

### For Engineering Lead (Jack)
- Monitor all systems: Check `systems/[NAME]/` for status & docs
- Review specs before hiring: `systems/[NAME]/docs/SPEC.md`
- Coordinate across teams: Cross-reference via [shared-docs/SYSTEM-ARCHITECTURE.md](./shared-docs/SYSTEM-ARCHITECTURE.md)

### For Individual Engineers
- **Storefront Engineer**: Start at [systems/storefront/docs/](./systems/storefront/docs/) & [systems/storefront/hiring/ONBOARDING.md](./systems/storefront/hiring/ONBOARDING.md)
- **Future Catalog Developer**: Start at [systems/catalog-admin/hiring/ONBOARDING.md](./systems/catalog-admin/hiring/)
- **New Service Owner**: Use [systems/[SERVICE]/docs/](./systems/) as your hub

### For HR/Hiring Managers
- Catalog Admin hiring: [systems/catalog-admin/hiring/BRIEF.md](./systems/catalog-admin/hiring/)
- Storefront hiring: [systems/storefront/hiring/BRIEF.md](./systems/storefront/hiring/)

---

## 📝 Adding a New System

When creating a new service (e.g., `payment-service`):

1. Create directory: `systems/payment-service/{docs,hiring}/`
2. Add `systems/payment-service/docs/README.md` with overview
3. Create `systems/payment-service/docs/SPEC.md` with technical spec
4. If hiring: Create `systems/payment-service/hiring/{JOB-POSTING.md,HIRING-BRIEF.md}`
5. Link from [shared-docs/SYSTEM-ARCHITECTURE.md](./shared-docs/SYSTEM-ARCHITECTURE.md)

---

## 🔗 Quick Links

**Active Projects**:
- [Catalog Admin Spec](./systems/catalog-admin/docs/SPEC.md) – Ready to hire
- [Catalog Admin Hiring](./systems/catalog-admin/hiring/) – Job posting & brief
- [Storefront Progress](./systems/storefront/docs/) – Sprint 1 in progress

**Platform Documentation**:
- [System Architecture](./shared-docs/SYSTEM-ARCHITECTURE.md)
- [API Contracts](./shared-docs/CONTRACTS.md)
- [Deployment & Docker](./shared-docs/DEPLOYMENT.md)
- [Git & PR Workflow](./shared-docs/CONVENTIONS.md)

**Agent Configuration**:
- [Engineering Lead Agent](./.agents/engineering-lead.md)
- [Storefront Engineer Agent](./.agents/storefront-engineer.md)

---

## ⚠️ Notes

- **Service Code**: `systems/[service]/code/` contains the actual service implementation (Dockerfile, `package.json`, `src/`)
  - Service code and build assets now live under `systems/[SERVICE]/code/`
  - Documentation remains in `systems/[SERVICE]/docs/` for visibility & organization
  
- **Symlinks (Optional)**: If desired, `systems/[SERVICE]/code/` can symlink to the actual service directory for IDE navigation

- **PRs & Code Review**: Service PRs go in service directories (e.g., PR to `catalog-admin/`). Spec/hiring docs also branch-reviewed.

---

**Last Updated**: June 3, 2026  
**Maintained By**: Engineering Lead

---

**Next Steps**:
1. ✅ Directory structure created
2. ⏳ Move existing docs into appropriate `/systems/*/` directories
3. ⏳ Create README.md for each system
4. ⏳ Create shared-docs index files
5. ⏳ Update agent configs to reference new locations

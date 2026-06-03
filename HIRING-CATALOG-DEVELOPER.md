# Job Posting: Catalog Management System Developer

**Position Title**: Catalog Developer (Full-Stack)  
**Team**: ImagiBricks Engineering  
**Reports To**: Engineering Lead  
**Location**: Remote (or flexible)  
**Duration**: Full-time, ongoing  
**Start Date**: ASAP  
**Compensation**: [HR to fill in]

---

## Role Summary

Build the **Catalog Management System** for ImagiBricks—a full-stack web application that empowers internal teams (warehouse, marketing, operations) to create, manage, and publish products to our e-commerce storefront.

You'll own the end-to-end implementation of the catalog-admin service, including:
- **Frontend**: Interactive React UI for product/variant/image management
- **Backend**: Express.js API with PostgreSQL persistence
- **DevOps**: Docker integration and local dev environment setup

This is a **greenfield Phase 1 project** with a well-defined spec and clear success criteria. You'll have autonomy to make technical decisions within the locked tech stack.

---

## Key Responsibilities

1. **Implement Product Management System**
   - Product CRUD (create, list, detail, update, delete)
   - Variant management with bulk creation support
   - Image upload and gallery with drag-drop reordering
   - SEO slug generation and metadata handling

2. **Build Admin Dashboard**
   - React-based UI with search, filtering, pagination
   - Tabbed product detail interface
   - Auto-save with debouncing
   - Responsive design (desktop & tablet)

3. **Implement Audit & Version Control**
   - Full change history logging (who changed what, when)
   - Version snapshots with rollback capability
   - Change diff visualization in audit tab

4. **API & Database Design**
   - ~15 REST endpoints with proper error handling
   - PostgreSQL schema design (audit_logs, versions, images tables)
   - Inventory system integration
   - Request validation and input sanitization

5. **Testing & Documentation**
   - Unit tests for controllers and business logic
   - E2E tests for critical user workflows
   - Code comments and README documentation
   - Developer handoff notes

6. **Docker & Deployment**
   - Dockerfile for catalog-admin service
   - Docker Compose integration
   - Local volume management for image storage
   - Environment variable configuration

---

## Required Skills

- **React** (TypeScript preferred) – build interactive UIs with forms, tables, modals
- **Node.js / Express.js** – REST API design, middleware, error handling
- **PostgreSQL** – schema design, queries, transactions
- **Docker & Docker Compose** – containerization, local dev setup
- **Frontend state management** (Zustand, Context API, or Redux)
- **HTML/CSS** (Tailwind CSS experience a plus)
- **Git** – version control, PR workflows

## Nice-to-Have Skills

- Cypress or Playwright (E2E testing)
- Image handling / file uploads (multer)
- Zod or Joi (schema validation)
- Microservices architecture experience
- Previous e-commerce platform work

---

## Tech Stack (Locked – Not Negotiable)

- **Frontend**: React 18+, TypeScript, Tailwind CSS, TanStack Table, React Hook Form, Zustand
- **Backend**: Node.js, Express.js, PostgreSQL (pg library), multer for uploads
- **Deployment**: Docker, Docker Compose
- **Testing**: Jest (unit), Cypress/Playwright (E2E)

---

## Phase 1 Scope (MVP – 4–6 weeks estimated)

✅ **Included:**
- Product/variant CRUD
- Image management (upload, reorder, delete)
- Publish/unpublish workflow
- Full audit trail & version history
- Local image storage (Docker volumes)
- Auto-save UI patterns
- Basic role-based access (mock auth for Phase 1)

❌ **Not included (Phase 2+):**
- Multi-currency support (USD only)
- Bulk CSV import/export
- Affiliate commission tiers
- Scheduled publishing
- S3 image storage
- Production auth integration

---

## Success Criteria

By end of Phase 1, the developer will have:

1. ✅ Created a fully functional product management UI (list, detail, create, edit, delete)
2. ✅ Implemented variant management with bulk variant generation
3. ✅ Built image gallery with drag-drop reordering and upload
4. ✅ Implemented full audit logging and version rollback
5. ✅ Integrated with existing PostgreSQL database
6. ✅ Validated inventory items exist (API call to inventory-service)
7. ✅ Deployed catalog-admin in Docker Compose alongside other services
8. ✅ Written unit tests (target: >70% code coverage)
9. ✅ Written E2E tests for critical workflows
10. ✅ Delivered clean, commented code with documentation

---

## Work Environment & Expectations

- **Autonomy**: Once spec is approved, you make design decisions within the tech stack
- **Code Review**: All PRs require review before merge to `main` (ImagiBricks engineering standard)
- **Collaboration**: Daily standup with Engineering Lead; pair programming as needed
- **Deliverables**: Weekly progress updates; checklist-driven implementation (42 concrete tasks)
- **Documentation**: Code comments, README, and developer handoff notes

---

## Getting Started

1. Clone the ImagiBricks engineering repo
2. Review [CATALOG-ADMIN-SPEC.md](./CATALOG-ADMIN-SPEC.md) – this is your detailed technical specification
3. Set up local dev: `docker-compose up` (all services + PostgreSQL)
4. Follow the implementation checklist (~42 tasks)
5. Weekly sync with Engineering Lead for blockers & design questions

---

## Compensation & Benefits

[HR to complete]

---

## How to Apply

Candidates should:
1. Provide a GitHub profile or portfolio (React + Node.js projects preferred)
2. Answer: "Why are you interested in building internal tools for e-commerce?"
3. Technical screening: Pair programming on a small feature (variant bulk creation helper)
4. Final round: Spec review & architecture questions with Engineering Lead

---

## Next Steps (HR / Hiring Manager)

1. Post this job description internally and externally
2. Screen for React + Node.js + PostgreSQL experience
3. Conduct initial phone screens (focus on e-commerce or admin system experience)
4. Schedule technical screening (coding challenge + spec review)
5. Coordinate final round with Engineering Lead (Jack)

**Contact**: Engineering Lead (Jack) – for technical questions or candidate vetting

---

## Reference Materials for Candidate

- **Technical Spec**: [CATALOG-ADMIN-SPEC.md](./CATALOG-ADMIN-SPEC.md) (comprehensive 400-line spec with all API endpoints, DB schema, component breakdown, and implementation checklist)
- **Project Context**: [REPO-LAYOUT.md](./REPO-LAYOUT.md) – monorepo structure
- **System Architecture**: [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md) – how catalog-admin fits in the platform
- **Existing Services**: storefront (React), order-service (Node/Express), catalog-service (Node/Express + PostgreSQL)

---

**Prepared by**: Engineering Lead  
**Date**: June 3, 2026  
**Status**: Ready for HR posting

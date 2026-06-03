# Catalog Admin System

**Status**: 📋 Specification Complete – Ready to Hire  
**Owner**: To be assigned (Catalog Developer)  
**Reports To**: Engineering Lead  

---

## Overview

The **Catalog Admin** system is the internal product management interface for ImagiBricks. It allows warehouse, marketing, and operations teams to:
- Create and manage products, variants (SKUs), pricing
- Upload and organize product images
- Publish products to the storefront
- Manage product metadata, categories, SEO
- Track full audit history and rollback versions
- Link to inventory system

## Status Timeline

| Phase | Timeline | Status |
|-------|----------|--------|
| Design & Spec | Weeks 1-2 | ✅ Complete |
| Hiring & Interview | Weeks 3-5 | ⏳ In Progress |
| Development | Weeks 6-11 | 🔳 Not Started |
| QA & Launch | Week 12 | 🔳 Not Started |

---

## 📁 What's Here

### `/docs/`
- **SPEC.md** – Complete technical specification (400+ lines)
  - Functional requirements
  - Technical architecture (React FE, Express.js BE, PostgreSQL DB)
  - API endpoints
  - Database schema
  - Implementation checklist (42 tasks)
  - Success criteria

### `/hiring/`
- **JOB-POSTING.md** – Role description for job boards
- **HIRING-BRIEF.md** – Internal hiring brief for HR
  - Technical profile
  - Interview plan
  - Evaluation rubric
  - Compensation guidance

---

## 🚀 Quick Links

- **Full Specification**: [docs/SPEC.md](./docs/SPEC.md) – Start here for technical details
- **Hiring Materials**: [hiring/](./hiring/) – Job posting and HR brief
- **Phase 1 Features**: MVP scope, all locked requirements in SPEC.md

---

## 👥 Team

| Role | Name | Status |
|------|------|--------|
| Product Owner | Jack (CEO) | ✅ Active |
| Engineering Lead | Jack | ✅ Active |
| Catalog Developer | TBD | 🔳 Hiring |

---

## 📋 Phase 1 Scope (MVP)

✅ **Must Have:**
- Product CRUD (create, list, detail, update, delete)
- Variant management with bulk creation
- Image upload & drag-drop reordering
- Publish/unpublish workflow
- Full audit trail with version rollback
- Local Docker volume storage

❌ **Not in Phase 1:**
- CSV bulk import
- Multi-currency (USD only)
- Affiliate tiers
- Scheduled publishing
- S3 storage (Phase 2)
- Production auth integration

---

## 🔧 Tech Stack (Locked)

- **Frontend**: React 18+, TypeScript, Tailwind CSS, Vite
- **Backend**: Node.js, Express.js, PostgreSQL
- **Storage**: Local Docker volumes
- **Testing**: Jest (unit), Cypress/Playwright (E2E)

---

## 🎯 Success Criteria

Phase 1 is complete when:
1. ✅ Admin can create/list/edit/publish products
2. ✅ Variants management with pricing & inventory linking
3. ✅ Images upload with drag-drop reordering
4. ✅ Full audit trail visible with version rollback
5. ✅ Docker Compose integration working
6. ✅ Responsive design (desktop & tablet)

---

## ⏭️ Next Steps

1. **Engineering Lead** reviews SPEC.md
2. **HR** posts [JOB-POSTING.md](./hiring/JOB-POSTING.md) to job boards
3. **Engineering Lead** conducts technical interviews
4. **Catalog Developer** starts onboarding & Phase 1 development
5. **Weekly sync** with Engineering Lead on progress

---

## ✅ Review & Approval Workflow

- **Storefront Engineer** must review and agree to the catalog-admin API shape and published-state behavior before implementation begins.
- **Engineering Lead** must approve the final API contract and Phase 1 implementation plan.
- All PRs should reference `systems/catalog-admin/docs/SPEC.md` and `docs/adr/0001-catalog-api-contract.md`.
- Implementation begins only after the contract is signed off by both engineers and the Engineering Lead.

---

**Last Updated**: June 3, 2026  
**Maintained By**: Engineering Lead

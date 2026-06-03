# Storefront System

**Status**: 🚀 Sprint 1 In Progress  
**Owner**: Storefront Engineer  
**Reports To**: Engineering Lead  

---

## Overview

The **Storefront** is the customer-facing website for ImagiBricks e-commerce platform. It includes:
- Product catalog browsing with search & filters
- Product detail pages with variants & pricing
- Shopping cart management
- Checkout flow with Stripe payment integration
- Customer account management
- Affiliate referral tracking

## Status Timeline

| Phase | Timeline | Status |
|-------|----------|--------|
| Hiring | Week 1 | ✅ Complete |
| Onboarding | Week 1 | ✅ Complete |
| Sprint 1: Catalog Pages | Weeks 2-3 | 🚀 In Progress |
| Sprint 2: Cart & Checkout | Weeks 4-6 | 🔳 Not Started |
| Sprint 3: Accounts | Weeks 7-8 | 🔳 Not Started |
| Launch & Monitoring | Week 9+ | 🔳 Not Started |

---

## 📁 What's Here

### `/docs/`
- **ADR-*.md** – Architecture Decision Records
  - Tech stack decisions (React, Vite, Tailwind)
  - State management approach
  - API integration patterns
- **IMPLEMENTATION-STATUS.md** – Current sprint progress
- **QUICK-START.md** – Development guide

### `/hiring/`
- **ONBOARDING.md** – Storefront engineer kickoff guide
  - First week setup checklist
  - Development workflow
  - Sprint roadmap

---

## 🚀 Quick Links

- **Current Sprint**: [docs/IMPLEMENTATION-STATUS.md](./docs/IMPLEMENTATION-STATUS.md)
- **Engineering Decisions**: [docs/](./docs/) – ADRs and architecture docs
- **Developer Guide**: [hiring/ONBOARDING.md](./hiring/ONBOARDING.md)
- **Live App**: http://localhost:3000 (when running `docker-compose up`)

---

## 👥 Team

| Role | Name | Status |
|------|------|--------|
| Product Owner | Jack (CEO) | ✅ Active |
| Engineering Lead | Jack | ✅ Active |
| Storefront Engineer | [Hired] | ✅ Active |

---

## Sprint 1: Catalog Pages (Current)

**Goal**: Browse products and view details with live data from catalog-service

✅ **Completed:**
- React + Vite + Tailwind setup
- ProductList component with search, filter, pagination
- ProductCard component
- SearchBar component with category filter
- API integration with catalog-service
- Responsive design (desktop, tablet, mobile)
- Build verified (1.34s)

⏳ **Next:**
- ProductDetail page
- Variant selection UI
- "Add to Cart" button (stubbed)
- Error handling refinement
- PR review with Engineering Lead

---

## 🔧 Tech Stack

- **Frontend**: React 18+, TypeScript, Tailwind CSS
- **Build**: Vite (10x faster than webpack)
- **Server**: Express.js (API proxy to backend services)
- **HTTP**: axios or fetch
- **State**: React Context or Zustand
- **Testing**: Jest (unit), Cypress/Playwright (E2E)

---

## 📦 Service Dependencies

- **catalog-service** (`http://localhost:4001/api/`) – Product catalog
- **order-service** (`http://localhost:4002/api/`) – Order creation (Sprint 2)
- **inventory-service** (`http://localhost:4003/api/`) – Stock checks (later)
- **affiliate-service** (`http://localhost:4004/api/`) – Referral tracking (later)

---

## 🎯 Success Criteria (Sprint 1)

- ✅ ProductList page working with live data
- ✅ Search & category filtering functional
- ✅ ProductDetail page implemented
- ✅ Responsive across all devices
- ✅ Error handling & loading states
- ✅ Code reviewed & approved by Engineering Lead
- ✅ PR merged to main

---

## 💻 Local Development

```bash
# Start all services (from engineering root)
docker-compose up

# In storefront directory, Terminal 1: Run dev server
npm run dev

# Terminal 2 (optional): Run Express proxy server
npm run dev:server

# Browser: http://localhost:5173 (Vite dev server)
```

---

## 📚 Documentation

- [System Architecture](../../shared-docs/SYSTEM-ARCHITECTURE.md) – Platform overview
- [API Contracts](../../shared-docs/CONTRACTS.md) – Service API specs
- [Git Workflow](../../shared-docs/CONVENTIONS.md) – PR standards
- [Deployment Guide](../../shared-docs/DEPLOYMENT.md) – Docker & local setup

---

## ⏭️ Next Steps

1. **Complete ProductDetail page**
2. **Add variant selection UI**
3. **Create PR with progress**
4. **Engineering Lead review**
5. **Feedback incorporation**
6. **Merge to main**
7. **Start Sprint 2 (Cart & Checkout)**

---

**Last Updated**: June 3, 2026  
**Maintained By**: Storefront Engineer & Engineering Lead

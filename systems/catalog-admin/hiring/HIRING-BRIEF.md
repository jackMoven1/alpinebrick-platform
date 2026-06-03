# Catalog Developer Hiring Brief – For HR/Hiring Manager

**Prepared by**: Engineering Lead (Jack's Engineering)  
**Date**: June 3, 2026  
**Urgency**: High – blocks Phase 2 features for storefront

---

## Executive Summary

**Role**: Catalog Developer (Full-Stack)  
**Commitment**: 4–6 weeks for Phase 1 MVP  
**Team Size**: 1 person (dedicated, full-time)  
**Key Skill**: React + Node.js + PostgreSQL (see technical profile below)

The role is well-scoped with a detailed specification. The developer has clear success criteria and will integrate into an existing, functional engineering organization.

---

## Business Context

ImagiBricks is building an e-commerce platform. The **catalog-admin service** enables internal teams (warehouse, marketing, ops) to manage products, variants, pricing, and images without touching code.

**Why this matters**: Without this system, product management requires manual database edits. With it, non-technical staff can launch products in minutes.

---

## Position Details

| Item | Value |
|------|-------|
| **Title** | Catalog Developer (Full-Stack) |
| **Reports To** | Engineering Lead (Jack) |
| **Duration** | Full-time, ongoing |
| **Location** | Remote/flexible |
| **Start Date** | ASAP |
| **Salary Band** | [HR to define] |
| **Estimated Effort Phase 1** | 4–6 weeks |

---

## Technical Profile (What We're Looking For)

### Must-Have
- **React** (3+ years, TypeScript preferred)
- **Node.js / Express.js** (API design, middleware)
- **PostgreSQL** (schema design, queries, transactions)
- **Docker** (containerization, compose)
- **Git** (PR workflows)

### Strong Plus
- E-commerce or admin system experience
- Full-stack autonomy (comfortable owning FE + BE)
- Microservices architecture
- Automated testing (Jest, Cypress, Playwright)

### Red Flags
- Only frontend OR only backend experience (we need full-stack)
- Has never worked in a monorepo
- Uncomfortable with spec-driven development
- Prefers to choose their own tech stack

---

## Key Documents for Candidate

1. **[CATALOG-ADMIN-SPEC.md](./CATALOG-ADMIN-SPEC.md)** ← Give this during initial interview
   - 400+ lines, comprehensive technical specification
   - All 15 API endpoints defined
   - Database schema, component breakdown, implementation checklist
   - This is the single source of truth

2. **[HIRING-CATALOG-DEVELOPER.md](./HIRING-CATALOG-DEVELOPER.md)** ← The job posting
   - Role summary, responsibilities, tech stack, phase 1 scope
   - Success criteria & next steps

3. **[SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md)** ← Context
   - How catalog-admin fits into the broader platform

---

## Interview Plan

### Round 1: Phone Screen (30 min)
- **Focus**: Career fit, React/Node/PostgreSQL depth
- **Sample Q**: "Describe your most complex full-stack project. What was hardest?"
- **Goal**: Confirm technical foundation

### Round 2: Technical Assessment (60–90 min, can be async)
- **Approach**: Live coding or take-home
- **Task**: Implement a small feature (e.g., "Build a bulk variant generator that takes a template and count, generates SKU patterns")
- **Goal**: See how they think, code quality, problem-solving

### Round 3: Specification Review + Architecture Q&A (60 min)
- **Who**: Engineering Lead (Jack)
- **Topics**:
  - Walk through CATALOG-ADMIN-SPEC
  - "How would you structure the React components?"
  - "Describe the audit logging approach"
  - "How would you handle concurrent edits to the same product?"
  - "Any concerns about the tech stack?"
- **Goal**: Assess ability to execute the spec, ask good questions, raise concerns early

---

## Evaluation Rubric

| Criterion | Excellent | Good | Concern |
|-----------|-----------|------|---------|
| **React** | Comfortable with hooks, context, form state | Has shipped React apps | Mostly jQuery/vanilla JS |
| **Node/Express** | Built APIs from scratch | Used Express in team project | Only REST client experience |
| **PostgreSQL** | Designed schemas, used transactions | Wrote queries, basic CRUD | Only ORMs, no raw SQL |
| **Docker** | Comfortable with Compose, volumes | Ran Docker locally | Heard of it but never used |
| **Full-Stack Autonomy** | Owns both FE & BE, makes tradeoff decisions | Comfortable with both, prefers one | Needs pairing on either FE or BE |

---

## Timeline Expectations

| Phase | Duration | Gate |
|-------|----------|------|
| **Posting & Screening** | 2–3 weeks | 5–10 qualified candidates |
| **Technical Assessment** | 1 week | Pass 60% code challenge |
| **Final Round** | 1 week | Engineering Lead approval |
| **Offer & Onboarding** | 1–2 weeks | Start date |
| **Phase 1 Development** | 4–6 weeks | 42-task checklist completion |

---

## Red Flags in Candidates

- ❌ "I'll choose a different stack (Vue, Python, Firebase)" – We need React + Node + PostgreSQL
- ❌ "What's PostgreSQL?" or "I've only used MongoDB" – Need SQL experience
- ❌ "I prefer backend" or "I'm a frontend specialist" – Role requires full-stack
- ❌ "Spec-driven work sounds boring" – This role IS spec-driven
- ❌ "When can I move to architecture/management?" – We need someone focused on execution

---

## Onboarding Checklist (First Day)

Once candidate is hired:

1. **Repository Access**
   - Git access to ImagiBricks engineering repo
   - Read-only access to parent folder (business context)

2. **Local Dev Setup**
   - Clone repo
   - `docker-compose up` (all services start)
   - Verify catalog-service DB is accessible
   - Verify storefront loads at `localhost:3000`

3. **Documentation Review**
   - CATALOG-ADMIN-SPEC.md (read entire)
   - SYSTEM-ARCHITECTURE.md (understand platform context)
   - REPO-LAYOUT.md (monorepo structure)
   - Engineering conventions (branch + PR, no direct commits to main)

4. **Kick-Off Meeting**
   - Engineering Lead walks through spec
   - Q&A on priorities (any MVP adjustments?)
   - Sprint planning: week 1 goals

---

## Success Criteria for Hire

By end of Phase 1 (4–6 weeks), the developer will have delivered:

✅ Fully functional product management UI  
✅ Variant management with bulk creation  
✅ Image gallery with drag-drop  
✅ Full audit logging & version rollback  
✅ PostgreSQL schema + migrations  
✅ ~15 REST API endpoints  
✅ Unit tests (>70% coverage)  
✅ E2E tests for critical workflows  
✅ Docker integration & documentation  
✅ Clean, reviewed code ready for production

---

## Compensation Guidance

[HR to provide market research for fullstack React/Node/PostgreSQL developer]

Recommended approach:
- Market rate for mid-level full-stack (3–5 years): $120k–$160k
- ImagiBricks stage/runway/burn: [CEO/CFO to advise]
- Consider: remote work flexibility, equity/options, learning budget

---

## Questions for Engineering Lead Before Posting

1. **Timeline**: Do we need the developer in 2 weeks, or can we wait 4 weeks for the right candidate?
2. **Geography**: Hiring constraints (US only, EU friendly, etc.)?
3. **Level**: Looking for mid-level, or open to junior + mentoring?
4. **Equity**: Should we offer options/equity in addition to salary?

---

## Final Checklist Before Posting

- [ ] **Salary band set** (HR/Finance)
- [ ] **Hiring manager assigned** (likely someone in ops/people team)
- [ ] **Job board decisions** (LinkedIn, Indeed, AngelList, internal only?)
- [ ] **Tech screen logistics** (who runs it? Async or live?)
- [ ] **Final round logistics** (Engineering Lead available for interviews?)
- [ ] **Onboarding plan** (who onboards dev on Day 1?)

---

## Contact & Next Steps

**Engineering Lead** (Jack): Technical questions, final candidate vetting, spec clarifications  
**HR/Hiring Manager**: Coordinate posting, initial screening, offer negotiation

**Action Items for HR**:
1. Review this brief and CATALOG-ADMIN-SPEC.md
2. Meet with Engineering Lead to align on level, comp, timeline
3. Post job description
4. Coordinate screening with Engineering Lead

**Timeline**: Ready to post immediately. First candidate could start within 3–4 weeks with efficient hiring.

---

**Prepared by**: Engineering Lead  
**Date**: June 3, 2026  
**Status**: Ready for HR handoff

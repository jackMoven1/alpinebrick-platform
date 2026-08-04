# Storefront Engineer – Onboarding & First Sprint

**Date**: June 3, 2026  
**Reports To**: Engineering Lead (Jack)  
**First Sprint Goal**: Product catalog page (product listing + detail view)  
**Timeline**: Week 1 (onboarding) + Weeks 2–3 (development)

---

## 🎯 Your Mission (Next 3 Weeks)

Build the **customer-facing storefront** for AlpineBrick. Start with:
1. **Product Listing Page** – Browse catalog, search, filter by category
2. **Product Detail Page** – View product, variants, images, add to cart
3. **Integration** – Pull live data from catalog-service API

---

## 📋 Onboarding Checklist (Week 1)

### Day 1: Setup & Context
- [ ] Clone repo: `git clone [engineering-repo]`
- [ ] `docker-compose up` – verify all services start (should see logs from catalog-db, catalog-service, storefront, etc.)
- [ ] Visit `http://localhost:3000` – should see placeholder storefront
- [ ] Read [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md) – understand platform topology
- [ ] Read [REPO-LAYOUT.md](./REPO-LAYOUT.md) – understand monorepo structure

### Day 2: API Integration
- [ ] Review [catalog-service API](./systems/catalog-service/code/README.md)
  - `GET /api/products` – list products with pagination
  - `GET /api/products/:id` – product detail with variants
  - `GET /api/products/:id/availability` – check stock
- [ ] Test catalog-service directly: `curl http://localhost:4001/api/products`
- [ ] Verify seed data loads (should see "Brick Builder Set" product in response)

### Day 3: Storefront Architecture Review
- [ ] Review current storefront code: `systems/storefront/code/src/index.js` and `systems/storefront/code/public/index.html`
- [ ] Understand current tech stack:
  - Frontend: **React 18** (or vanilla JS if converting)
  - Build: **Vite** (or webpack if converting)
  - Styling: **Tailwind CSS**
  - HTTP: **axios** or **fetch**
  - State: Context API or Zustand
- [ ] Decide: Keep existing stack or propose changes? (Document in ADR if changing)

### Day 4–5: First Feature & PR
- [ ] Set up feature branch: `git checkout -b feat/product-listing`
- [ ] Implement:
  - **ProductList component**: Fetch from catalog-service, render table/grid
  - **Search/filter**: By product name, category
  - **Pagination**: 20 products per page
- [ ] Create PR with description and screenshots
- [ ] Engineering Lead reviews & provides feedback

---

## 🏗️ Architecture (What You're Building Into)

```
storefront (Node.js + React)
  ├─ public/
  │  └─ index.html       → SPA entry point
  ├─ src/
  │  ├─ index.js         → Express server (serves SPA, proxies /api calls)
  │  ├─ components/
  │  │  ├─ ProductList.jsx
  │  │  ├─ ProductDetail.jsx
  │  │  ├─ Cart.jsx
  │  │  └─ Checkout.jsx
  │  ├─ pages/
  │  │  ├─ CatalogPage.jsx
  │  │  ├─ CheckoutPage.jsx
  │  │  └─ AccountPage.jsx
  │  ├─ services/
  │  │  └─ catalogService.js   → API calls to catalog-service
  │  ├─ context/
  │  │  ├─ CartContext.js      → Cart state
  │  │  └─ UserContext.js      → Auth state
  │  └─ styles/
  │     └─ tailwind.css
  ├─ Dockerfile
  ├─ package.json
  └─ README.md
```

**Key Integration Points**:
- **Catalog Service** (`http://catalog-service:4001/api/`) – Product catalog
- **Order Service** (`http://order-service:4002/api/`) – Checkout & order creation
- **Inventory Service** (`http://inventory-service:4003/api/`) – Stock availability

---

## 📦 Sprint Roadmap

### Sprint 1 (This Week): Foundation
**Goal**: Product listing & detail pages working with live catalog data

- [ ] ProductList page
  - Fetch products from catalog-service
  - Display in grid or table
  - Search by name
  - Filter by category
  - Pagination (20 per page)
  
- [ ] ProductDetail page
  - Fetch product by ID
  - Display images, description, variants
  - Show pricing
  - Add to cart button (cart is stubbed for now)
  
- [ ] Navigation
  - Home → Product listing
  - Product listing → Product detail
  - Back button

- [ ] Error handling
  - Network errors → user-friendly messages
  - 404 → "Product not found"
  - Loading states → spinner/skeleton

### Sprint 2–3: Cart & Checkout (TBD with Engineering Lead)
- Shopping cart (add/remove/update quantity)
- Checkout page (form → order submission)
- Order confirmation
- Referral code integration
- Stripe payment (Phase 2)

---

## 🔗 API Reference

### Catalog Service

**List Products**
```
GET http://localhost:4001/api/products?page=1&limit=20

Response:
{
  "products": [
    {
      "id": "prod-001",
      "slug": "brick-builder-set",
      "name": "Brick Builder Set",
      "description": "A premium starter set...",
      "categories": ["starter", "creative"],
      "images": ["/images/brick-builder.jpg"],
      "variants": [
        {
          "id": "sku-001",
          "sku": "IB-SET-001",
          "price": 39.99,
          "currency": "USD",
          "attributes": {"color": "multicolor"}
        }
      ]
    }
  ],
  "total": 1,
  "page": 1
}
```

**Get Product Detail**
```
GET http://localhost:4001/api/products/prod-001

Response:
{
  "id": "prod-001",
  "name": "Brick Builder Set",
  "description": "...",
  "images": [...],
  "variants": [...]
}
```

**Check Availability**
```
GET http://localhost:4001/api/products/prod-001/availability

Response:
{
  "in_stock": true,
  "quantity_available": 100
}
```

---

## 🚀 Development Workflow

### Git Workflow
```bash
# Create feature branch
git checkout -b feat/product-listing

# Make commits (atomic, descriptive)
git add .
git commit -m "feat: add ProductList component with search"

# Push and create PR
git push origin feat/product-listing

# Wait for Engineering Lead review
# Respond to feedback, push more commits if needed

# Once approved, merge to main
git checkout main
git pull
git merge feat/product-listing
```

### Local Testing
```bash
# Terminal 1: Start all services
cd /path/to/engineering
docker-compose up

# Terminal 2: Watch for changes (optional, if using Vite dev server)
cd storefront
npm run dev

# Browser: Visit http://localhost:3000
```

### Debugging
- **Network errors**: Open DevTools (F12) → Network tab → check requests to `http://localhost:4001`
- **React errors**: React DevTools browser extension
- **Backend logs**: `docker-compose logs catalog-service` (or any service name)

---

## 📚 Key Documents

1. **[SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md)** – Platform overview
2. **[REPO-LAYOUT.md](./REPO-LAYOUT.md)** – Monorepo structure
3. **[CONTRACTS.md](./CONTRACTS.md)** – API contracts between services
4. **[systems/storefront/code/README.md](./systems/storefront/code/README.md)** – Storefront-specific setup
5. **[systems/catalog-service/code/README.md](./systems/catalog-service/code/README.md)** – Catalog API docs

---

## 🤝 Support & Communication

- **Daily Standup**: 9:30 AM (or async on Slack)
- **Blockers**: Ping Engineering Lead on Slack immediately
- **Code Review**: Engineering Lead usually responds within 4–8 hours
- **Architecture Questions**: Schedule 30-min sync with Engineering Lead (e.g., "Should we use Redux or Zustand for state?")

---

## ⚠️ Important Constraints

✅ **Tech Stack (Locked)**:
- React 18+
- Tailwind CSS
- Vite or Create React App
- axios or fetch for HTTP

❌ **Don't Do**:
- Direct commits to `main` (always PR)
- Push secrets (API keys, passwords) to repo
- Add external services (Auth0, Segment, etc.) without approval
- Change docker-compose.yaml without consulting Engineering Lead

---

## 💡 Quick Tips

1. **Start small**: Get ProductList working before tackling ProductDetail
2. **Use browser DevTools**: Network tab is your friend for debugging API issues
3. **Commit frequently**: Easier to review 5 small commits than 1 large one
4. **Read error messages**: 90% of issues are in the error log
5. **Ask questions**: Better to ask early than waste time debugging

---

## 🎯 Week 1 Deliverable

By end of week 1 (Friday):
- [ ] Local dev environment working (`docker-compose up` succeeds)
- [ ] ProductList page renders and fetches from catalog-service
- [ ] Basic search functionality
- [ ] First PR submitted with ProductList implementation
- [ ] Engineering Lead review & feedback incorporated

---

## Next Meeting

**Engineering Lead Kickoff** (Day 1 afternoon):
- Walkthrough of codebase
- Storefront architecture decisions
- Sprint planning
- Any blockers?

**First PR Review** (End of Day 4):
- Go over feedback
- Discuss design patterns
- Agree on conventions (naming, file structure, etc.)

---

**You're ready to go!** Questions? Slack the Engineering Lead.

Good luck! 🚀

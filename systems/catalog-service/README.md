# Catalog Service System

**Status**: ✅ MVP Complete – PostgreSQL-backed  
**Owner**: Backend (Built by Engineering Lead)  
**Exposes**: REST API for product catalog  

---

## Overview

The **Catalog Service** is the backend service that manages the product catalog. It:
- Stores products, variants, pricing in PostgreSQL
- Exposes REST API for catalog operations
- Integrates with inventory-service for stock availability
- Serves catalog-admin and storefront with product data

## Architecture

- **Server**: Node.js + Express.js
- **Database**: PostgreSQL (shared with catalog-admin)
- **Port**: 4001
- **API Base**: `http://localhost:4001/api/`

---

## 📁 What's Here

### `/docs/`
- **API-REFERENCE.md** – REST endpoint documentation
- **DATABASE-SCHEMA.md** – PostgreSQL schema & queries
- **INTEGRATION.md** – How other services integrate with catalog-service

---

## 🚀 Status

✅ **MVP Complete:**
- PostgreSQL database with products, variants, images tables
- JSONB support for flexible metadata
- Seed data loaded (Brick Builder Set product)
- Docker integration working
- Exposes `/api/products` endpoints

⏳ **Future Enhancements:**
- Search indexing (Elasticsearch)
- Caching layer (Redis)
- Catalog analytics

---

## 📦 API Overview

**List Products**
```
GET /api/products?page=1&limit=20
```

**Get Product Detail**
```
GET /api/products/{id}
```

**Check Availability**
```
GET /api/products/{id}/availability
```

(See [docs/](./docs/) for full API reference)

---

## 🔧 Tech Stack

- Node.js + Express.js
- PostgreSQL 15 (Alpine)
- pg library (no ORM)
- Docker containerization

---

## 📚 Documentation

- [API Reference](./docs/API-REFERENCE.md) – Full endpoint docs
- [Database Schema](./docs/DATABASE-SCHEMA.md) – Schema & queries
- [Integration Guide](./docs/INTEGRATION.md) – How other services use this

---

## Service Dependencies

- **PostgreSQL** (shared database at `catalog-db`)
- **Inventory Service** (validation only, future)

---

## ⏭️ Future Work

- [ ] Search & filtering by category, price range
- [ ] Product recommendations engine
- [ ] Bulk product import/export
- [ ] Version control for product changes
- [ ] Catalog analytics & insights

---

**Last Updated**: June 3, 2026  
**Maintained By**: Engineering Lead

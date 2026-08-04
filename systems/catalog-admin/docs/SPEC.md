# Catalog Management System – Developer Specification
**Date**: June 3, 2026  
**Phase**: Phase 1 (MVP)  
**Status**: Ready for Implementation  
**Estimated Effort**: 4–6 weeks (1 developer)

---

## 1. PROJECT OVERVIEW

Build a **Catalog Management System** (catalog-admin service) that allows AlpineBrick employees to:
- Create and manage products and variants (SKUs)
- Upload and organize product images
- Publish/unpublish products to the storefront
- View and restore product version history
- Manage product metadata (categories, descriptions, SEO)
- Link products to inventory items
- Track who changed what, when (full audit trail)

**Target User**: AlpineBrick internal staff (warehouse, marketing, operations teams)  
**Tech Stack**: React (TypeScript) + Express.js (Node.js) + PostgreSQL  
**Deployment**: Docker Compose (local dev) → Kubernetes-ready (future)

---

## 2. FUNCTIONAL REQUIREMENTS

### 2.1 Product Management

#### Create Product
- Form fields: name, description, categories, slug (auto-generated), metadata (brand, weight, dimensions, custom JSON)
- Initial state: Draft (unpublished)
- Validation: name & slug required; slug must be unique
- Success: Product created in DB with `created_by` user ID and timestamp
- Error handling: Duplicate slug, validation failures

#### List Products
- Table view with pagination (20 per page default)
- Columns: ID, name, variant count, published status, last modified date, actions
- Filters: search by name/ID, by category, by published status
- Sorting: by name, by modified date, by created date
- Bulk actions: Publish/unpublish multiple products

#### View Product Detail
- Tabbed interface:
  - **Info Tab**: name, description, categories, slug, metadata (editable, auto-save)
  - **Variants Tab**: Table of variants with SKU, price, inventory link, actions
  - **Images Tab**: Drag-drop media gallery; alt text per image
  - **Publishing Tab**: State selector (Draft/Published/Archived), publish/unpublish buttons
  - **Audit Tab**: Change log showing: timestamp, user, action, what changed

#### Update Product
- Inline editing with auto-save (debounced 1s)
- Partial updates (don't require all fields)
- Track changes in audit log with old → new values (JSONB diff)
- Prevent concurrent edits: optimistic locking or warning if another user editing

#### Delete Product
- Archive product (soft delete): set `archived_at` timestamp, hide from storefront
- Permanent deletion not available Phase 1 (archived products remain in DB)

#### Publish Product
- Action: Change `published` flag to true, set `published_at` timestamp
- Validation: Product has at least one variant, at least one image recommended
- Success: Product visible on storefront after cache clear (if applicable)

#### Unpublish Product
- Action: Change `published` flag to false
- Storefront: Product becomes unavailable to customers

### 2.2 Variant Management

#### Create Variant
- Form fields: SKU (unique), price (USD), currency (hardcoded USD), inventory_item_id (link to inventory-service), attributes (JSONB, e.g., color: "red", size: "M")
- Validation: SKU must be unique within product; price required; inventory_item_id validates with inventory-service API
- Success: Variant created, linkage to product and inventory item established

#### Bulk Variant Creation
- Helper: Generate N variants from template
- Example: "Create S/M/L/XL variants, each with price $X.XX"
- Action: Generate SKU pattern (e.g., `PROD-{product_id}-{size}`), attributes, price
- Result: Preview and confirm before bulk insert

#### Update Variant
- Editable fields: SKU, price, inventory_item_id, attributes
- Auto-save on change
- Audit logging for price changes (useful for cost tracking)

#### Delete Variant
- Remove variant from product
- Validation: Product must have at least one variant to remain "sellable"
- Cascade: Soft or hard delete depending on order history (Phase 2 decision)

### 2.3 Image Management

#### Upload Images
- Support: JPG, PNG, WEBP (max 5MB per file, 20 files per product)
- Storage: Local Docker volume (path: `/data/images/{product_id}/{timestamp}-{filename}`)
- Success: Return image URL for display in UI
- Metadata: Alt text field (optional, used for accessibility)

#### Image Gallery
- Drag-drop reordering (updates `display_order` in DB)
- Delete image action
- Alt text inline editor
- Preview thumbnail for each image

#### Display Order
- Explicit `display_order` integer in images table
- Sorted by this field when fetching product detail
- Update on reorder drag-drop

### 2.4 Publishing & States

#### States
- **Draft**: Product visible in admin only, not on storefront
- **Published**: Product visible on storefront, purchasable
- **Archived**: Hidden from both admin list and storefront; searchable in admin for historical reference

#### Publish/Unpublish
- Single-click publish/unpublish from product detail page
- Bulk publish/unpublish from product list (multi-select)
- Success message + timestamp of action

#### Publish Validation
- Warn if: no variants, no images, no description (but allow publish anyway Phase 1)

### 2.5 Audit & Version History

#### Change Tracking
- **audit_logs table**: Every create/update/delete action logged with:
  - `id` (UUID)
  - `entity_type` ('product' or 'variant')
  - `entity_id` (product or variant ID)
  - `action` ('create', 'update', 'publish', 'unpublish', 'delete')
  - `changed_fields` (JSONB: `{old: {...}, new: {...}}`)
  - `user_id` (who made the change)
  - `timestamp` (ISO 8601)

#### Version History
- **versions table**: Full product snapshots on each significant update:
  - `id` (UUID)
  - `entity_type` ('product' or 'variant')
  - `entity_id`
  - `version_number` (auto-incrementing per entity)
  - `data` (JSONB: full product/variant state)
  - `created_by` (user ID)
  - `created_at` (timestamp)

#### Audit Tab in UI
- Display change log: timestamp, user, action, summary of change
- Expandable rows to show old → new values side-by-side
- **Rollback action**: "Restore to this version" button
  - Confirmation dialog: "This will create a new version based on [version_number]. Continue?"
  - Rollback creates new version entry (audit trail preserved)

#### Version Comparison (Phase 1 Optional)
- Show diff between any two versions (nice-to-have, not MVP-critical)

---

## 3. TECHNICAL ARCHITECTURE

### 3.1 Frontend (React + TypeScript)

#### Pages/Routes
```
/admin/
  ├─ /products                    → Product list
  ├─ /products/new               → Create product form
  ├─ /products/:id               → Product detail (tabbed)
  ├─ /products/:id/variants      → Variant manager (or embedded in detail)
  └─ /login                       → Auth (Phase 2 if needed; mock for Phase 1)
```

#### Components
- **ProductList**: Table with search, filters, bulk actions
- **ProductDetail**: Tabs (Info, Variants, Images, Publishing, Audit)
- **ProductForm**: Fields for product metadata
- **VariantTable**: CRUD variant rows
- **BulkVariantForm**: Template-based variant generator
- **ImageGallery**: Drag-drop upload & reorder
- **AuditLog**: Formatted change log with rollback buttons
- **DeleteConfirm / PublishConfirm**: Modal dialogs

#### State Management
- **Zustand** or **React Context** for:
  - Current product data (with dirty flag for unsaved changes)
  - Current user (ID, role)
  - Notifications (toast: success, error, info)
  - Loading states

#### UI Framework
- **Tailwind CSS** for styling (consistent with storefront)
- **Headless UI** for dialogs & modals
- **React Hook Form** for form handling & validation
- **TanStack Table** for product list & variant tables

#### API Calls
- **axios** or **fetch** to call catalog-admin backend
- Base URL: `http://localhost:3001/api/admin` (dev) or configurable env var
- Error boundary for API failures
- Retry logic for transient 5xx errors

#### Validation
- Client-side: `zod` schema validation
- Display inline error messages
- Disable submit button until form valid

#### Image Upload
- Use `<input type="file">` with drag-drop zone
- On select: POST to `/api/admin/products/:id/images`
- Receive: `{ id, url, display_order }`
- Add to gallery immediately with optimistic UI update

#### Auto-Save
- Debounce form input changes (1 second)
- Debounce image reorder drag-drop (500ms)
- PUT changes to API
- Show "Saving..." indicator while in flight
- Show "Saved" checkmark on success

### 3.2 Backend (Express.js + Node.js)

#### File Structure
```
catalog-admin/
├─ src/
│  ├─ index.js                 → Express app entry, middleware setup
│  ├─ middleware/
│  │  ├─ auth.js               → JWT / session auth middleware
│  │  └─ errorHandler.js       → Global error handler
│  ├─ routes/
│  │  ├─ products.js           → Product CRUD routes
│  │  ├─ variants.js           → Variant CRUD routes
│  │  ├─ images.js             → Image upload/reorder routes
│  │  ├─ publishing.js         → Publish/unpublish routes
│  │  └─ audit.js              → Audit log & version routes
│  ├─ controllers/
│  │  ├─ productController.js  → Business logic for products
│  │  ├─ variantController.js  → Business logic for variants
│  │  ├─ imageController.js    → Business logic for images
│  │  └─ auditController.js    → Business logic for audit/versions
│  ├─ models/
│  │  ├─ Product.js            → Product queries (create, read, update, etc.)
│  │  ├─ Variant.js            → Variant queries
│  │  ├─ Image.js              → Image queries
│  │  ├─ AuditLog.js           → Audit log queries
│  │  └─ Version.js            → Version queries
│  ├─ services/
│  │  ├─ db.js                 → PostgreSQL pool & schema init (shared with catalog-service)
│  │  ├─ auditService.js       → Helper to create audit log entries
│  │  ├─ versionService.js     → Helper to create & restore versions
│  │  └─ inventoryService.js   → API calls to inventory-service for validation
│  ├─ validators/
│  │  └─ schemas.js            → Zod/Joi schemas for request validation
│  └─ public/
│     └─ index.html            → Frontend SPA entry point
├─ package.json
├─ Dockerfile
└─ README.md
```

#### Middleware
- **Auth**: Extract user from JWT token or session; attach `req.user` with `{id, role}`
  - For Phase 1: Mock auth (set `req.user = {id: 'admin-1', role: 'admin'}`)
- **Error Handler**: Catch all errors, return `{error: "message", code: "ERROR_CODE"}`
- **Logging**: Log all requests with method, path, response status, user ID

#### API Endpoints

##### Products
```
POST   /api/admin/products
       Request: {name, description, categories[], slug?, metadata}
       Response: {id, name, ...}
       
GET    /api/admin/products?page=1&search=brick&category=toys&published=true
       Response: {items: [{id, name, variant_count, published, updated_at}], total, page}
       
GET    /api/admin/products/:id
       Response: {id, name, description, ..., variants: [...], images: [...], published}
       
PUT    /api/admin/products/:id
       Request: {name?, description?, ..., categories?}
       Response: {id, name, ...}
       Audit: Log changed fields
       
DELETE /api/admin/products/:id
       Response: {success: true}
       Audit: Log deletion (soft delete to archive)
```

##### Variants
```
POST   /api/admin/products/:id/variants
       Request: {sku, price, inventory_item_id, attributes}
       Response: {id, product_id, sku, price}
       
PUT    /api/admin/products/:id/variants/:vid
       Request: {sku?, price?, inventory_item_id?, attributes?}
       Response: {id, ...}
       
DELETE /api/admin/products/:id/variants/:vid
       Response: {success: true}
       
POST   /api/admin/products/:id/variants/bulk-create
       Request: {template: {sku_prefix, price, attributes_template}, count, values}
       Example: {template: {sku_prefix: "PROD-001-", price: 29.99}, 
                 values: ["S", "M", "L"]} 
       → Creates PROD-001-S, PROD-001-M, PROD-001-L
       Response: {created: [{id, sku, ...}]}
```

##### Images
```
POST   /api/admin/products/:id/images
       Body: multipart/form-data {file, alt_text?}
       Response: {id, url, display_order}
       Storage: /data/images/{product_id}/{timestamp}-{filename}
       
PUT    /api/admin/products/:id/images/reorder
       Request: {images: [{id, display_order}, ...]}
       Response: {success: true}
       
DELETE /api/admin/products/:id/images/:iid
       Response: {success: true}
```

##### Publishing
```
POST   /api/admin/products/:id/publish
       Response: {id, published: true, published_at}
       Audit: Log "publish" action
       
POST   /api/admin/products/:id/unpublish
       Response: {id, published: false}
       Audit: Log "unpublish" action
       
POST   /api/admin/products/bulk-publish
       Request: {product_ids: ["prod-001", "prod-002"]}
       Response: {updated: 2}
```

##### Audit & Versions
```
GET    /api/admin/products/:id/audit
       Response: {logs: [{timestamp, user_id, action, changed_fields, summary}]}
       
GET    /api/admin/products/:id/versions
       Response: {versions: [{version_number, created_at, created_by, data}]}
       
POST   /api/admin/products/:id/rollback/:version_id
       Request: {}
       Response: {id, version_number} (new version created)
       Audit: Log "rollback" action with ref to old version_number
```

#### Request Validation
- Use **Zod** schemas in validators/
- Validate in controller or as middleware before business logic
- Return 400 with error details if invalid

#### Database Queries
- Use `pg` library (same as catalog-service)
- Connection pool shared via `db.js`
- Write parameterized queries (prevent SQL injection): `$1, $2, ...`

#### Error Handling
- Standard response format: `{error: "message", code: "ERROR_CODE", status: 400}`
- Error codes: `PRODUCT_NOT_FOUND`, `SKU_DUPLICATE`, `INVALID_REQUEST`, etc.
- HTTP status: 200 (success), 400 (client error), 409 (conflict), 500 (server error)

#### Audit Log Helper (auditService.js)
```javascript
async function logChange(entityType, entityId, action, oldData, newData, userId) {
  const changedFields = computeDiff(oldData, newData);
  await db.query(
    `INSERT INTO audit_logs (entity_type, entity_id, action, changed_fields, user_id, timestamp)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [entityType, entityId, action, JSON.stringify(changedFields), userId]
  );
}
```

#### Version Helper (versionService.js)
```javascript
async function createVersion(entityType, entityId, data, userId) {
  const versionNumber = await getNextVersionNumber(entityType, entityId);
  await db.query(
    `INSERT INTO versions (entity_type, entity_id, version_number, data, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [entityType, entityId, versionNumber, JSON.stringify(data), userId]
  );
}

async function rollbackToVersion(entityType, entityId, versionId, userId) {
  const version = await db.query(
    `SELECT data FROM versions WHERE id = $1`,
    [versionId]
  );
  const oldData = version.rows[0].data;
  // Restore to products or variants table
  await updateEntity(entityType, entityId, oldData);
  // Create new version entry
  await createVersion(entityType, entityId, oldData, userId);
  // Log rollback action
  await logChange(entityType, entityId, 'rollback', null, oldData, userId);
}
```

#### Image Upload Handler
- Use **multer** middleware: `multer({dest: '/data/images', limits: {fileSize: 5MB, files: 20}})`
- On upload:
  1. Receive file
  2. Validate product exists
  3. Rename file with timestamp
  4. Store path in images table
  5. Return `{id, url: "/images/{product_id}/{filename}", display_order}`
- Serve static files: `app.use('/images', express.static('/data/images'))`

#### Inventory Validation
- On variant create/update, call inventory-service to validate `inventory_item_id` exists:
  ```javascript
  const invResponse = await axios.get(
    `http://inventory-service:4003/api/inventory/${inventory_item_id}`
  );
  if (!invResponse.data) throw new Error('Inventory item not found');
  ```

### 3.3 Database Schema (PostgreSQL)

#### New/Enhanced Tables

**products** (extend existing)
```sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
```

**variants** (extend existing)
```sql
ALTER TABLE variants ADD COLUMN IF NOT EXISTS updated_by TEXT;
-- attributes already exists as JSONB
```

**images** (new table)
```sql
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  alt_text TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_images_product_id ON images(product_id);
```

**audit_logs** (new table)
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,           -- 'product' or 'variant'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- 'create', 'update', 'publish', 'unpublish', 'delete', 'rollback'
  changed_fields JSONB NOT NULL DEFAULT '{}', -- {old: {...}, new: {...}}
  user_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
```

**versions** (new table)
```sql
CREATE TABLE IF NOT EXISTS versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,           -- 'product' or 'variant'
  entity_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  data JSONB NOT NULL,                 -- Full product/variant state at this version
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_versions_entity ON versions(entity_type, entity_id);
```

---

## 4. IMPLEMENTATION BREAKDOWN & REVIEW

### 4.1 Sprint 1 Deliverables
- Finalize the catalog-admin API contract with the Storefront Engineer before implementation begins.
- Build the backend scaffold and database migrations first, then the matching frontend scaffold in parallel.
- Deliver the first working end-to-end flow: product create → variant add → image upload → publish.
- Ensure the storefront review covers response shapes, filtering/pagination semantics, image URL conventions, and published state behavior.

### 4.2 Storefront Review Checklist
The Storefront Engineer must review and agree to the following design details before this work is declared final:
- Product list response shape (`/api/admin/products`): list items, pagination envelope, published state, variant count, category tags.
- Product detail payload (`/api/admin/products/:id`): variants, images, metadata, prices, inventory linkage data, product state.
- Variant data contract: SKU, price, inventory_item_id, attributes JSON, availability semantics.
- Image contract: URL format, display_order, alt_text, static file path conventions, reorder API payload.
- Publish/unpublish flow: endpoint names, response state, `published_at` semantics, storefront visibility rules.
- Query syntax for filters/search: query params, default sort/page size, published/draft category handling.
- Error contract: consistent `{error, code, status}` shape for frontend handling.

### 4.3 Final Agreement Process
1. Catalog Engineer publishes this SPEC and the ADR draft to the shared repo.
2. Storefront Engineer reviews the API contract and the implementation task list.
3. Storefront feedback is incorporated into this spec and the ADR until both engineers agree on the final contract.
4. Engineering Lead reviews the final SPEC and ADR, then signs off by updating status to `ACCEPTED` in `docs/adr/0001-catalog-api-contract.md` and noting approval in this spec.
5. Implementation begins after approval; PRs reference the spec and ADR, and changes are not merged without Engineering Lead review.

### 4.4 Acceptance Criteria for Review
The implementation is ready to proceed when:
- The Storefront Engineer has confirmed the contract covers required browse + detail data.
- The API shapes are documented and versioned in the ADR.
- The Engineering Lead has approved the final contract and the MVP task plan.
- The work is scoped to Phase 1: admin UI, backend CRUD, image handling, publish workflow, audit trail.

---

## 5. IMPLEMENTATION CHECKLIST

### Phase 1 MVP (4–6 weeks)

#### Backend
- [ ] Express.js scaffold with middleware (auth mock, error handler, logging)
- [ ] Database schema (create images, audit_logs, versions tables; alter products/variants)
- [ ] Product CRUD routes & controllers
- [ ] Variant CRUD routes & controllers
- [ ] Image upload/reorder routes & controllers
- [ ] Publish/unpublish routes
- [ ] Audit log routes & versionService helper
- [ ] Inventory validation integration
- [ ] Error handling & validation
- [ ] Unit tests (controllers & models)
- [ ] Docker build & Compose integration

#### Frontend
- [ ] React SPA scaffold (Vite or Create React App)
- [ ] Auth mock (hardcode admin user)
- [ ] ProductList page with search/filter/pagination
- [ ] ProductDetail page (tabbed layout)
- [ ] ProductForm component (create & edit)
- [ ] VariantTable component with CRUD
- [ ] BulkVariantForm component
- [ ] ImageGallery component (drag-drop, upload, reorder)
- [ ] AuditLog component with rollback
- [ ] Auto-save with debounce
- [ ] Error handling & loading states
- [ ] E2E tests (basic happy paths)
- [ ] Docker build

#### DevOps
- [ ] Update docker-compose.yaml for catalog-admin volume mounts (`/data/images`)
- [ ] Volume setup for image storage
- [ ] Env vars for DATABASE_URL, API_BASE_URL
- [ ] Local dev instructions (README)

---

## 5. DEPLOYMENT & ENVIRONMENT

### Local Development
```yaml
# docker-compose.yaml additions
catalog-admin:
  build: ./systems/catalog-admin/code
  ports:
    - '3001:3001'
  environment:
    - NODE_ENV=development
    - DATABASE_URL=postgresql://postgres:postgres@catalog-db:5432/alpinebrick_catalog
    - CATALOG_SERVICE_URL=http://catalog-service:4001
    - INVENTORY_SERVICE_URL=http://inventory-service:4003
  volumes:
    - ./systems/catalog-admin/code/src:/app/src
    - /app/node_modules
    - catalog-admin-images:/data/images
  depends_on:
    - catalog-db

volumes:
  catalog-admin-images:
```

### Environment Variables
```
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://postgres:postgres@catalog-db:5432/alpinebrick_catalog
CATALOG_SERVICE_URL=http://catalog-service:4001
INVENTORY_SERVICE_URL=http://inventory-service:4003
IMAGE_STORAGE_PATH=/data/images
```

---

## 6. TESTING STRATEGY

### Backend Unit Tests
- Product CRUD (create valid/invalid, read, update, delete)
- Variant CRUD
- Audit logging
- Version rollback
- Input validation

### Frontend E2E Tests (Cypress or Playwright)
- Create product
- Add variant
- Upload images
- Publish product
- Rollback version

### Manual Testing
- Full product lifecycle (create → variants → images → publish)
- Drag-drop image reordering
- Concurrent edit scenario (user A & B edit same product)
- Image upload edge cases (oversized, wrong format)

---

## 7. DEVELOPER HANDOFF NOTES

- **Tech stack is locked**: React, Express, pg, Tailwind
- **Monorepo**: catalog-admin is a service inside the AlpineBrick engineering repo
- **Shared DB**: catalog-admin uses same PostgreSQL database as catalog-service
- **Local dev**: `docker-compose up` starts all services
- **API contract**: Catalog-service already exposes `/api/products` endpoints; catalog-admin builds on top
- **No external services Phase 1**: Local file storage only; no S3/Auth0/third-party deps
- **User model Phase 1**: Mock auth (single "admin" user); real auth in Phase 2
- **Code review**: All PRs require review before merge to `main` (per AlpineBrick conventions)

---

## 8. SUCCESS CRITERIA

✅ **Phase 1 Complete when:**
1. Admin can create, list, edit, publish products from UI
2. Variants are CRUD-able with price & inventory linking
3. Images can be uploaded and reordered via drag-drop
4. Full audit trail visible in UI with version rollback
5. All CRUD operations logged in audit_logs table
6. Stack runs in Docker Compose locally without errors
7. Storefront reflects product changes (catalog-service queries updated DB)
8. Responsive design works on desktop and tablet

---

**Next Step**: Engineering Lead to review, refine if needed, then post as job description for Phase 1 developer hire.

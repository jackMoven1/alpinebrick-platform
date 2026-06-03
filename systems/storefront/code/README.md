# ImagiBricks Storefront

Customer-facing React web application for ImagiBricks eCommerce platform.

## Tech Stack

- **Frontend**: React 18 with Vite
- **Styling**: Tailwind CSS
- **HTTP**: Axios
- **Server**: Express (API proxy + static file serving)

## Architecture

```
┌─────────────────┐
│  Vite Dev       │ (port 5173, development only)
│  React App      │
└────────┬────────┘
         │ /catalog
         ↓
┌────────────────────┐
│ Express Server     │ (port 3000)
│ - API Proxy        │
│ - Static Files     │
└────────┬───────────┘
         │
    ┌────┴────┬────────┬──────────┐
    ↓         ↓        ↓          ↓
┌───────────────┐┌─────────────┐┌──────────────┐┌─────────────┐
│ Catalog Svc   ││ Order Svc   ││ Inventory Svc││ Affiliate   │
│ (4001)        ││ (4002)      ││ (4003)       ││ Svc (4004)  │
└───────────────┘└─────────────┘└──────────────┘└─────────────┘
```

## Development

### Prerequisites
- Node.js 20+
- Docker (for backend services)

### Setup

1. Install dependencies:
```bash
npm install
```

2. Start backend services:
```bash
cd ..
docker-compose up
```

3. In one terminal, start the Express server:
```bash
npm run dev:server
```

4. In another terminal, start the Vite dev server (hot reload):
```bash
npm run dev
```

5. Open browser to:
- **Frontend**: http://localhost:5173 (Vite dev server)
- **API**: http://localhost:3000 (Express server)

### Build

```bash
npm run build
```

This compiles React to static files in `dist/` directory.

### Production

```bash
npm start
```

Starts Express server on port 3000, serving the React build from `dist/`.

## File Structure

```
storefront/
├── src/
│   ├── main.jsx                 # React entry point
│   ├── App.jsx                  # Root component
│   ├── server.js                # Express server
│   ├── components/
│   │   ├── ProductList.jsx      # Main listing page
│   │   ├── ProductCard.jsx      # Product card component
│   │   └── SearchBar.jsx        # Search & filter UI
│   ├── services/
│   │   └── catalogService.js    # Catalog API client
│   └── styles/
│       └── index.css            # Tailwind styles
├── index.html                   # React root HTML
├── package.json
├── vite.config.js               # Vite configuration
├── tailwind.config.js           # Tailwind configuration
├── postcss.config.js            # PostCSS configuration
├── Dockerfile
└── README.md
```

## API Integration

The storefront proxies requests to backend services:

- **Catalog** (`/catalog/*`) → catalog-service:4001
- **Orders** (`/orders/*`) → order-service:4002
- **Inventory** (`/inventory/*`) → inventory-service:4003
- **Affiliates** (`/affiliates/*`) → affiliate-service:4004

### Catalog Service Example

```javascript
import catalogService from './services/catalogService'

// Fetch products
const response = await catalogService.getProducts({
  search: 'brick',
  category: 'starter',
  page: 1,
  limit: 20
})

console.log(response.products)  // Array of products
console.log(response.totalPages) // Total pages for pagination
```

## Component Architecture

### ProductList
- Manages product loading, filtering, and pagination
- Handles search and category filtering
- Renders grid of ProductCard components

### ProductCard
- Displays individual product with image, description, price
- Shows categories as badges
- "View Details" button for future product detail page

### SearchBar
- Search input for product name/description
- Category dropdown filter
- Clear filters button

## Styling

Tailwind CSS is configured for mobile-first, responsive design.

Key breakpoints:
- `sm`: 640px
- `md`: 768px
- `lg`: 1024px

Example component with responsive grid:
```jsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {products.map(product => (
    <ProductCard key={product.id} product={product} />
  ))}
</div>
```

## Next Steps

- [ ] Product detail page
- [ ] Shopping cart
- [ ] Checkout integration (Stripe)
- [ ] Customer accounts
- [ ] Affiliate referral tracking
- [ ] Order history page
- [ ] Unit and integration tests

## Support

Questions or blockers? Contact the Engineering Lead.

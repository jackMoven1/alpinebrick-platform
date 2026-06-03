# ADR: Storefront Tech Stack & Architecture

**Date**: June 3, 2026  
**Status**: Proposed for Engineering Lead Review  
**Author**: Storefront Engineer

## Context

The storefront requires a modern, performant React application to serve the customer-facing website for ImagiBricks. We need to:
- Browse and search products from catalog-service
- Display products in a responsive grid
- Filter by category and search terms
- Handle pagination (20 items per page)
- Serve static files efficiently in production
- Support hot module reloading during development

## Constraints

- Onboarding guide specifies React 18+, Tailwind CSS, and Vite as the default stack
- Must work with docker-compose for local development
- All backend services are behind HTTP APIs
- Single container per service in production

## Decision

Implement storefront as a **React 18 SPA** built with **Vite** and styled with **Tailwind CSS**, served by **Express** which also proxies API calls to backend services.

### Tech Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | React 18 | Modern, component-based, large ecosystem, specified in onboarding |
| Build Tool | Vite | Fast dev server, smaller bundles, faster builds (1.3s vs ~10s webpack) |
| Styling | Tailwind CSS | Utility-first, rapid UI development, no custom CSS needed |
| HTTP Client | Axios | Promise-based, interceptors, better error handling than fetch |
| State | React Hooks + Context | Simple for catalog browsing, sufficient for Phase 1 (no Redux overhead) |
| Server | Express | Node.js ecosystem, already in use, simple proxy middleware |
| Build Output | Static SPA | dist/ folder served by Express, traditional web app architecture |

## Architecture

### Development
- **Port 5173**: Vite dev server (hot reload)
  - Proxies `/catalog/*` requests to Express on 3000
  - Serves React assets with source maps
- **Port 3000**: Express server (proxy layer)
  - Proxies `/catalog/*` to catalog-service:4001
  - Proxies other routes to respective backend services
  - Serves static files in production

### Production
- **Port 3000**: Express server
  - Serves React build from `dist/` folder
  - Proxies API requests to backend services
  - SPA fallback: `/` routes serve `dist/index.html` for client-side routing

### Request Flow (Development)
```
Browser (5173) 
  → Vite Dev Server 
    → /catalog requests proxied to Express (3000)
      → Express proxies to catalog-service (4001)
```

### Request Flow (Production)
```
Browser (3000)
  → Express server
    → Static SPA from dist/
    → API requests proxied to backend services
```

## File Structure

```
systems/storefront/code/
├── src/
│   ├── main.jsx                   # React entry point
│   ├── App.jsx                    # Root component
│   ├── server.js                  # Express server (production)
│   ├── components/
│   │   ├── ProductList.jsx        # Main catalog listing
│   │   ├── ProductCard.jsx        # Single product display
│   │   └── SearchBar.jsx          # Search and filter UI
│   ├── services/
│   │   └── catalogService.js      # Catalog API wrapper
│   └── styles/
│       └── index.css              # Tailwind + global styles
├── index.html                     # SPA root HTML
├── package.json
├── vite.config.js                 # Vite config with proxies
├── tailwind.config.js
├── postcss.config.js
└── Dockerfile
```

## Benefits

1. **Developer Experience**
   - Hot module reloading with Vite (instant feedback)
   - Component-based architecture (reusable, testable)
   - Tailwind utilities reduce CSS boilerplate

2. **Performance**
   - Vite's tree-shaking results in smaller bundles
   - React 18 concurrent rendering
   - Static files can be cached by CDN

3. **Maintenance**
   - React ecosystem is well-documented
   - Vite is actively maintained
   - Clear separation of concerns (components, services)

4. **Scalability**
   - Easy to add new components
   - Service layer can evolve (add caching, error handling)
   - Can migrate to state management (Redux, Zustand) if needed later
   - Express proxy layer can handle additional backend services

## Tradeoffs & Mitigation

| Tradeoff | Mitigation |
|----------|-----------|
| Bundle size (193KB JS) | Lazy loading routes and code splitting in Phase 2 |
| SPA initial load time | Can add service worker for offline support in Phase 2 |
| SEO limitations | Can add SSR or use Next.js for marketing pages if needed |
| No type checking | Can add TypeScript gradually (start with JSDoc) |

## Future Considerations

- **Phase 2**: Add product detail page, cart, checkout
- **Phase 3**: Integrate Stripe payment
- **Performance**: Add service workers, optimize images
- **Type Safety**: Migrate to TypeScript for larger codebase
- **Testing**: Add Vitest + React Testing Library
- **Monitoring**: Add error tracking (Sentry) and analytics

## Implementation Status

✅ Core components implemented:
- ProductList (with search, filter, pagination)
- ProductCard (product display)
- SearchBar (search + category filter)
- catalogService (API wrapper)
- Express proxy server
- Vite + Tailwind setup
- Dockerfile for production build

✅ Tested:
- Build process works (npm run build)
- React compiles with Vite
- API calls work with live catalog-service
- dist/ folder properly generated

⏳ Ready for:
- Engineering Lead review
- Local testing (npm run dev + dev:server)
- Docker build test
- Feedback on architecture

## Questions for Engineering Lead

1. ✅ React 18 + Vite + Tailwind approved? (or prefer alternative stack?)
2. Should we add TypeScript from the start, or migrate later?
3. For affiliate referral attribution: should it be a URL param, cookie, or both?
4. Should we set up CI/CD pipeline for this project?
5. Any specific performance targets or lighthouse scores to target?

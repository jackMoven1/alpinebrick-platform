import { createBrowserRouter } from 'react-router'

import Root from './app/Root'
import HydrateFallback from './app/HydrateFallback'
import NotFound from './pages/NotFound'

import Home, { homeLoader } from './pages/Home'
import Collections from './pages/Collections'
import CollectionDetail, { collectionLoader } from './pages/CollectionDetail'
import ProductDetail, { productLoader } from './pages/ProductDetail'
import Cart from './pages/Cart'
import Terms from './pages/legal/Terms'
import Privacy from './pages/legal/Privacy'
import Checkout from './pages/Checkout'
import OrderComplete from './pages/OrderComplete'

import Support from './pages/support/Support'
import FAQ from './pages/support/FAQ'
import Shipping from './pages/support/Shipping'
import Returns from './pages/support/Returns'

import About from './pages/company/About'
import Designers from './pages/company/Designers'
import Careers from './pages/company/Careers'
import Press from './pages/company/Press'
import Community from './pages/company/Community'

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Root,
    errorElement: <NotFound />,
    // Without this the router paints nothing until every loader settles on
    // first load — a blank page for the customer.
    HydrateFallback,
    children: [
      { index: true, Component: Home, loader: homeLoader },

      { path: 'product/:id', Component: ProductDetail, loader: productLoader },
      { path: 'collections', Component: Collections },
      {
        path: 'collections/:slug',
        Component: CollectionDetail,
        loader: collectionLoader,
        // An unknown slug throws a 404 Response from the loader; render the
        // 404 page rather than an empty grid claiming the collection exists.
        errorElement: <NotFound />,
      },
      { path: 'cart', Component: Cart },
      { path: 'legal/terms', Component: Terms },
      { path: 'legal/privacy', Component: Privacy },

      // Stripe Embedded Checkout (spec 2026-09-27 §6). Stripe's return_url
      // lands on /order/complete?session_id=...
      { path: 'checkout', Component: Checkout },
      { path: 'order/complete', Component: OrderComplete },

      { path: 'support', Component: Support },
      { path: 'support/faq', Component: FAQ },
      { path: 'support/shipping', Component: Shipping },
      { path: 'support/returns', Component: Returns },
      // Order tracking needs a carrier integration and the contact form needs
      // a ticketing backend. Both are a later sub-project.
      { path: 'support/track-order', Component: NotFound },
      { path: 'support/contact', Component: NotFound },

      { path: 'about', Component: About },
      { path: 'designers', Component: Designers },
      { path: 'careers', Component: Careers },
      { path: 'press', Component: Press },
      { path: 'community', Component: Community },

      { path: '*', Component: NotFound },
    ],
  },
])

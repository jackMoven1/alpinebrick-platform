import { createBrowserRouter } from 'react-router'

import Root from './app/Root'
import NotFound from './pages/NotFound'

// Routes whose page component does not exist yet render NotFound rather than
// crashing the router. They are filled in as the pages land.
export const router = createBrowserRouter([
  {
    path: '/',
    Component: Root,
    errorElement: <NotFound />,
    children: [
      { index: true, Component: NotFound },

      { path: 'product/:id', Component: NotFound },
      { path: 'collections', Component: NotFound },
      { path: 'collections/:slug', Component: NotFound },
      { path: 'checkout', Component: NotFound },

      { path: 'support', Component: NotFound },
      { path: 'support/faq', Component: NotFound },
      { path: 'support/shipping', Component: NotFound },
      { path: 'support/returns', Component: NotFound },
      { path: 'support/track-order', Component: NotFound },
      { path: 'support/contact', Component: NotFound },

      { path: 'about', Component: NotFound },
      { path: 'designers', Component: NotFound },
      { path: 'careers', Component: NotFound },
      { path: 'press', Component: NotFound },
      { path: 'community', Component: NotFound },

      { path: '*', Component: NotFound },
    ],
  },
])

import { createBrowserRouter } from "react-router";

import Root from "./Root";
import Home from "./pages/Home";
import ProductDetail from "./pages/ProductDetail";
import Collections from "./pages/Collections";
import CollectionDetail from "./pages/CollectionDetail";

import Support from "./pages/support/Support";
import FAQ from "./pages/support/FAQ";
import Shipping from "./pages/support/Shipping";
import Returns from "./pages/support/Returns";
import TrackOrder from "./pages/support/TrackOrder";
import Contact from "./pages/support/Contact";

import Checkout from "./pages/Checkout";
import About from "./pages/company/About";
import Designers from "./pages/company/Designers";
import Careers from "./pages/company/Careers";
import Press from "./pages/company/Press";
import Community from "./pages/company/Community";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: Home },
      { path: "product/:id", Component: ProductDetail },
      { path: "collections", Component: Collections },
      { path: "collections/:slug", Component: CollectionDetail },
      { path: "checkout", Component: Checkout },
      { path: "support", Component: Support },
      { path: "support/faq", Component: FAQ },
      { path: "support/shipping", Component: Shipping },
      { path: "support/returns", Component: Returns },
      { path: "support/track-order", Component: TrackOrder },
      { path: "support/contact", Component: Contact },
      { path: "about", Component: About },
      { path: "designers", Component: Designers },
      { path: "careers", Component: Careers },
      { path: "press", Component: Press },
      { path: "community", Component: Community },
    ],
  },
]);

# Handoff: Alpine Brick Ecommerce Storefront

> **Start here:** open `CLAUDE.md` for the implementation brief, then `cd figma-src && npm install && npm run dev` to run the reference app. This README is the visual spec.

## Overview
Alpine Brick Exchange is an ecommerce storefront for custom-designed, limited-run LEGO-compatible sets. Audience: older children/teens who need to be visually pulled in, and AFOL (Adult Fan of LEGO) collectors shopping for one-of-a-kind sets. The product assortment starts small and grows, so the site is built around **spotlighting** a few hero products, a **filterable catalog**, and a straightforward path to cart.

Core flows in this bundle: browse home → filter catalog or browse a collection → product detail → add to cart → four-step checkout → order confirmation → track order. Plus the full support and company page set.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**.

The task is to **recreate these designs in the Alpine Brick platform's existing environment** using its established patterns, component library, routing, and data layer. Do not lift the HTML/inline styles verbatim. If no frontend environment exists yet, choose the appropriate framework (the original design was authored as React + React Router + Tailwind v4 tokens — see `figma-src/` — so that stack is a natural fit) and implement there.

Product data in these files is **placeholder content authored during design**. Wire the real catalog, pricing, inventory, and checkout from the Alpine Brick platform APIs.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interaction behavior. Recreate pixel-faithfully using the codebase's existing libraries. Every hex value, font size, and letter-spacing below is exact and taken from the design source.

---

## Design Tokens

### Color
| Token | Value | Use |
|---|---|---|
| `background` | `#0f0f0f` | Page background |
| `foreground` | `#f0ede8` | Primary text (warm off-white, NOT pure white) |
| `card` | `#181818` | Product cards, panels |
| `popover` | `#181818` | Overlays |
| `primary` | `#ffd100` | Brand yellow — CTAs, accents, active states |
| `primary-foreground` | `#0f0f0f` | Text on yellow |
| `secondary` | `#1e1e1e` | Inputs, subtle section fills |
| `muted` | `#242424` | Image placeholder backgrounds |
| `muted-foreground` | `#8a8a8a` | Secondary/body text |
| `accent` | `#ffffff` | Secondary badges, "Added ✓" confirm state |
| `accent-foreground` | `#0f0f0f` | Text on accent |
| `destructive` | `#e3000b` | Errors, remove-item hover |
| `border` | `rgba(255,255,255,0.08)` | All borders and dividers |
| `input-background` | `#1e1e1e` | Text inputs |
| `ring` | `rgba(255,209,0,0.5)` | Focus ring |

Difficulty labels: Beginner `#4ade80` · Intermediate `#ffd100` · Advanced `#fb923c` · Expert `#f87171`.

The theme is dark-only. `:root` and `.dark` carry identical values.

### Typography
- **Display** — `Barlow Condensed`, weights 400/700/800/900. Used at **900 only**, always `text-transform: uppercase`. Headings, prices, stat numbers, product names, logo wordmark.
- **Body** — `DM Sans`, weights 400/500/600. Paragraphs, labels, buttons, inputs.

Google Fonts import:
```
https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700;800;900&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap
```

Type scale as used:
| Role | Family | Size | Weight | Letter-spacing | Line-height |
|---|---|---|---|---|---|
| Hero H1 | Barlow Condensed | `clamp(64px, 8vw, 128px)` | 900 | `-0.02em` | 0.9 |
| Page H1 (Collections, Cart) | Barlow Condensed | 64–72px | 900 | normal | 0.95 |
| Section H2 | Barlow Condensed | 60px | 900 | normal | 1.0 |
| Product detail H1 | Barlow Condensed | 52px | 900 | normal | 1.05 |
| Product detail price | Barlow Condensed | 52px | 900 | normal | 1.0 |
| Spotlight card title | Barlow Condensed | 26px | 900 | normal | 1.05 |
| Catalog card title | Barlow Condensed | 22px | 900 | normal | 1.05 |
| Card price | Barlow Condensed | 24–30px | 900 | normal | 1.0 |
| Logo wordmark | Barlow Condensed | 21px | 900 | `0.12em` | — |
| Body paragraph | DM Sans | 14–18px | 400 | normal | 1.7 |
| Eyebrow / kicker | DM Sans | 10px | 700 | `0.2em` | — |
| Nav link | DM Sans | 12px | 600 | `0.15em` | — |
| Button label | DM Sans | 10–14px | 700–900 | `0.12em–0.15em` | — |
| Meta / caption | DM Sans | 10–12px | 400 | `0.15em` when uppercase | — |

Every uppercase micro-label (eyebrows, nav, buttons, badges, meta) is tracked out. This is the single most identity-defining typographic rule — do not drop the letter-spacing.

### Spacing & geometry
- Content max width **1280px**, horizontal padding **24px**.
- Major section vertical padding **112px**; secondary sections **64–80px**.
- Grid gaps: cards **24px**; spec/thumbnail grids **8–12px**.
- **Border radius: 2px** (`--radius: 0.125rem`) on buttons and inputs. Cards, badges, and images are **square (0px)**. The design is deliberately hard-edged — no rounded cards.
- **No shadows anywhere.** Depth comes from `#181818` surfaces on `#0f0f0f` plus 8%-white borders.
- Border width 1px everywhere, except product thumbnails (2px, to carry the active state) and the Builder Notes left rule (2px).

### Motion
- Color/border transitions: `0.2s–0.3s` ease.
- Image zoom on card hover: `transform: scale(1.05)`, `0.7s` ease.
- Trust marquee: `translateX(0 → -50%)`, `28s` linear, infinite. The item list is duplicated so the loop is seamless.
- Add-to-cart confirmation: button swaps to accent-white with "Added ✓" for **1600ms** (cards) / **2000ms** (product detail), then reverts.

---

## Screens / Views

### 1. Global chrome — Nav
- Sticky top, height **64px**, `z-index: 50`, background `rgba(15,15,15,0.95)` + `backdrop-filter: blur(8px)`, 1px bottom border.
- **Left:** brick logo (32px, see Assets) + wordmark "ALPINE BRICK". Whole lockup links home; wordmark goes `#ffd100` on hover.
- **Center:** Collections · New Arrivals · Limited Edition · About — 12px/600/`0.15em` uppercase, `#8a8a8a` → `#f0ede8` on hover, 32px gap.
- **Right:** search toggle, cart. Cart shows a 20px `#ffd100` circular badge with the item count when > 0.
- Search toggle reveals a full-width row below the bar: single input, `#1e1e1e` fill, 1px border, placeholder "Search sets, themes, piece counts…". Typing filters the catalog live across name, category, and piece count.

### 2. Global chrome — Footer
Four columns (`1.4fr 1fr 1fr 1fr`, 48px gap): brand blurb, then **Shop** / **Support** / **Company** link lists. Column headings 10px/700/`0.15em` uppercase; links 14px `#8a8a8a`. Bottom bar above a 1px rule: copyright left ("© 2026 Alpine Brick Exchange™. All rights reserved. Not affiliated with the LEGO Group."), Privacy · Terms · Cookies right.

### 3. Home
**Hero** — full viewport minus nav. Background photo at `opacity: 0.15` under a left-to-right gradient (`#0f0f0f` → `rgba(15,15,15,0.75)` at 55% → `rgba(15,15,15,0.2)`). Two-column grid, 64px gap.
- Left: bordered eyebrow pill ("⚡ Designed by AFOLs · Built for Builders", 1px `rgba(255,209,0,0.25)`) → H1 "BE A / **MASTER** / BUILDER" with "MASTER" in `#ffd100` → 18px body copy (max 448px) → two CTAs ("Shop Now →" solid yellow; "View Spotlights" outlined) → stat row above a 1px top rule: **500+** Custom Sets · **12K+** Builders · **4.9★** Avg Rating (numbers 30px Barlow 900, labels 10px tracked).
- Right: 4:5 product image, max 384px, right-aligned, with a bottom gradient caption block ("NEW DROP" in yellow / "DRAGON FORTRESS" / "3,156 pieces · $249") and two decorative offset squares: 80px outlined `rgba(255,209,0,0.3)` top-right at `-12px`, 48px filled `rgba(255,209,0,0.2)` bottom-left at `-12px`.

**Trust marquee** — full-bleed band, `rgba(30,30,30,0.4)`, 14px vertical padding, rules top and bottom. Items 10px/700/`0.18em` uppercase `#8a8a8a`, each prefixed with a yellow `◆`, 40px gap. Copy: Designed by AFOLs · Free Shipping Over $75 · Buy · Sell · Trade · Expert Builder Support · 30-Day Returns · Collector Grade Quality · Custom Commission Builds · Limited Runs Only.

**Spotlight Collection** — eyebrow "Featured Drops", H2 "SPOTLIGHT / COLLECTION", "View All ›" right-aligned. Two-up grid of large cards: 320px image with a bottom-up card-colored gradient scrim, badge top-left, then a 28px body containing category label, product name, right-aligned price + piece count, description, and a two-button row ("View Details" outlined / "Add to Cart" solid yellow).

**Full Catalog** — own band, `rgba(30,30,30,0.2)`, top rule. Eyebrow "Browse the Build", H2 "FULL / CATALOG". Filter chips: All · Architecture · Fantasy · Space · Ocean · Nature — 10px/700/`0.18em`, inactive = transparent fill + 8%-white border + `#8a8a8a`; active = `#ffd100` fill, `#0f0f0f` text, yellow border. Then a 3-up card grid: 208px image, optional badge, category label, name, 2-line description, price + piece count, and "Details" / "Add" buttons. Empty state: centered `◻` glyph at 25% opacity + "No sets in this category yet — check back soon".

**Why Alpine Brick Exchange** — centered eyebrow + H2, then a 3-up grid of bordered 32px panels (icon glyph in yellow, 22px display heading, 14px body). Panels: Exclusively Designed · Collector-Grade Quality · Drops That Matter.

**Newsletter** — full-bleed **`#ffd100`** band with the hero photo at `opacity: 0.1` behind. Centered: H2 "JOIN THE / EXCHANGE" at 72px in `#0f0f0f`, body at `rgba(15,15,15,0.75)`, then email input (`rgba(15,15,15,0.1)` fill, `rgba(15,15,15,0.25)` border) + "Join Now" button in `#0f0f0f` with `#ffd100` label. This is the only light-on-dark inversion in the site — keep it as the closing punctuation.

### 4. Collections
Header block: eyebrow "Browse by Theme", H1 "COLLECTIONS" (72px), 16px intro copy (max 560px). Then a 3-up grid of theme cards: 240px image at `opacity: 0.75` under a bottom scrim, theme name (30px display) and set count (10px yellow, tracked) overlaid at the bottom, plus a 20px blurb below. Clicking a theme routes to the catalog pre-filtered to that category; "Limited Edition" routes to the featured product.

### 5. Product Detail
**Breadcrumb bar** — 1px bottom rule, 10px tracked uppercase: "← Home › {category} › {product name}".

**Two-column body**, 80px gap.
- **Left (sticky, `top: 88px`):** 4:3 main image with badge top-left, prev/next arrow buttons (36px squares, `rgba(15,15,15,0.8)`, 1px border, vertically centered), and an "n / 4" counter chip bottom-right. Below: 4-up square thumbnail grid — active thumbnail carries a **2px `#ffd100`** border, others 8%-white. Below that, "# SET {setNumber}" in 10px tracked gray.
- **Right:** category eyebrow (yellow) with star rating + "4.9 (214 reviews)" on the same line → H1 product name (52px) → price (52px display) beside piece count and age recommendation, above a 1px rule → **2×2 spec grid** (Difficulty / Assembled Size / Piece Count / Set Number) in `rgba(30,30,30,0.4)` panels with 10px tracked labels and 14px/600 values; the Difficulty value takes its difficulty color → short description → **quantity stepper** (bordered −/n/+) beside a flex-1 "Add to Cart" button → three trust micro-items with yellow `✓` above a rule → **tab bar**.

**Tabs** (bottom-border style, active = `#ffd100` text + 2px yellow underline, inactive = `#8a8a8a`):
1. **Overview** — long description then a checklist of features, each with a yellow `✓`.
2. **In the Box** — list of included items, each with a yellow `◆`.
3. **Builder Notes** — 2px yellow left rule, 20px left padding, "FROM THE DESIGN TEAM" label in yellow, then the note in italic gray. This is the brand's voice — first-person, specific, unpolished. Preserve the tone when writing real copy.

**Related Sets** — own band (`rgba(30,30,30,0.2)`, top rule): eyebrow "You Might Also Like", H2 "RELATED SETS", "View All ›". 3-up compact cards (176px image, category, name, price, piece count). Populated with same-category products, falling back to any three others.

### 6. Cart / Checkout summary
Eyebrow "Secure Checkout", H1 "YOUR CART" (64px).
- **Empty state:** bordered panel, 80px padding, centered yellow `◆`, "Your cart is empty — go find something worth building", "Browse the Catalog" CTA.
- **Filled:** two columns (`1.7fr 1fr`, 48px gap). Left = line items — each a `120px / 1fr / auto` grid on a `#181818` card: 96px thumbnail, category + name + quantity stepper + "Remove" (hover `#e3000b`), and a right-aligned line total (28px display) with "$X each" beneath. Right = sticky (`top: 88px`) order summary panel: "ORDER SUMMARY" heading, Subtotal / Shipping / Estimated tax rows above a rule, then **Total** at 40px in `#ffd100`, "Place Order" (solid yellow) and "Keep Shopping" (outlined), and the three trust micro-items.

---

## Interactions & Behavior
- **Routing.** Five views: home, collections, product detail (`/product/:id`), cart, plus in-page anchors. Every navigation resets scroll to top (`behavior: "instant"`); "Shop Now" and "View All" smooth-scroll to the catalog section instead.
- **Catalog filtering.** Chip selection filters by category and clears any active search. Search takes precedence over the chip filter and matches across name, category, and piece count on every product including spotlights.
- **Add to cart.** Adds quantity (1 from cards, stepper value from product detail); if the line already exists, quantity increments. The button swaps to accent-white "Added ✓" for 1600ms (2000ms on product detail) then reverts. Nav cart badge updates immediately.
- **Quantity steppers.** Floor of 1 in both the product detail stepper and cart lines; removal is explicit via "Remove".
- **Gallery.** Prev/next wrap around; thumbnails jump directly; the image index resets to 0 on every product open.
- **Tabs.** Reset to Overview on every product open.
- **Hover.** Cards lighten their border toward `rgba(255,209,0,0.35–0.4)`; card images scale to 1.05 over 0.7s; text links go `#8a8a8a` → `#f0ede8`; outlined buttons go border+label yellow; solid yellow buttons darken to `#e6bd00`.
- **Responsive.** The reference is built at a 1440px desktop canvas. The original source (`figma-src/`) used Tailwind breakpoints: two-column grids collapse to one below `md`, the 3-up catalog grid steps 3 → 2 → 1 at `lg`/`sm`, the hero's right-hand image is hidden below `md`, and the nav links collapse into a hamburger sheet below `md`. Reproduce that behavior.
- **Not designed yet:** loading skeletons, error states, form validation, payment step, auth. Apply platform conventions and flag anything that needs a design pass.

## State Management
Design-level state (replace with the platform's real data layer where noted):
| State | Type | Trigger | Notes |
|---|---|---|---|
| `page` / route | enum | nav, card clicks, CTAs | Real routing |
| `productId` | number | product open | Route param |
| `category` | string | filter chip | Default `"All"` |
| `query` | string | search input | Overrides category when non-empty |
| `tab` | enum | tab click | Resets to `overview` per product |
| `imageIndex` | number | arrows / thumbnails | Resets to 0 per product |
| `qty` | number | stepper | Min 1, resets to 1 per product |
| `cart` | `[{id, qty}]` | add / stepper / remove | **Server-backed** — must persist across sessions |
| `justAdded` | id \| null | add to cart | Transient confirmation, auto-clears |
| `searchOpen` | boolean | search toggle | — |

Cart math in the design: shipping is **free over $75**, otherwise **$12**; tax estimated at **8.75%**. Replace all three with real platform rules — treat these as placeholders, not business logic.

Data fetching: catalog list (home, collections), single product by id (detail, incl. images/features/includes/builder notes/rating), cart read + mutate. The design assumes 4 images per product and complete spec metadata for every set — confirm the platform's product model can supply `pieces`, `difficulty`, `ageRecommendation`, `dimensions`, `setNumber`, `builderNotes`, `rating`, `reviewCount`, `features[]`, `includes[]`, and `badge`, or agree on fallbacks.

## Assets
- **Fonts:** Barlow Condensed + DM Sans, Google Fonts (import above). Self-host if the platform requires it.
- **Logo:** inline SVG, 36×36 viewBox — `#111111` rounded rect (`rx=3`) with four `#FFD100` studs (r=5.5) at (12,12) (24,12) (12,24) (24,24), each with a `#111111` @ 45% inner circle (r=2.8) for the stud shadow. Rendered at 32px in the nav, 28px in the footer. Exact source in `Alpine Brick.dc.html`.
- **Icons:** the original used **lucide-react** (ShoppingCart, Search, Menu, X, Star, Check, Package, Layers, Clock, Ruler, Hash, Users, ChevronLeft/Right, ArrowLeft/Right, Zap, Award). The HTML reference substitutes inline SVG and typographic glyphs. **Use lucide (or the platform's icon set) in the real build** — do not ship the glyph substitutes.
- **Photography:** all product imagery is **placeholder Unsplash stock** and some IDs may not resolve. Every set needs real photography — 4 images per product, 4:3 for the detail hero. Image containers use `#242424` as the loading/failed background.
- **Badges:** text-only, no image assets — "Best Seller", "New", "Limited", "One of a Kind", "Designer Series". Color rule: Limited / One of a Kind → yellow on dark; New / Designer Series → white on dark; everything else → `#f0ede8` on dark.

## Files
| Path | What it is |
|---|---|
| `Alpine Brick.dc.html` | **Primary reference.** Self-contained HTML prototype of all 19 screens — working cart, four-step checkout, filtering, sorting, gallery, tabs, accordion, and forms. Opens in any browser. |
| `figma-src/src/app/` | The original Figma Make React/TypeScript source, recovered from the `.make` file — `Root.tsx` (nav/footer), `pages/Home.tsx`, `pages/ProductDetail.tsx`, `pages/Collections.tsx`, `pages/CollectionDetail.tsx`, `pages/Checkout.tsx`, `context/CartContext.tsx`, `routes.ts`, `data.ts`, plus support/company pages. **Closest thing to production code — read this for exact Tailwind classes and responsive breakpoints.** |
| `figma-src/` (root) | **Runnable.** `npm install && npm run dev` — Vite + React 18 + React Router v7 + Tailwind v4 scaffold wrapping the recovered source, so the reference app boots as-is at `localhost:5173`. |
| `figma-src/src/styles/globals.css` | Tailwind entry: font import, the full token block, and the `@theme inline` mapping that makes `bg-background` / `text-primary` / `border-border` resolve. |
| `figma-src/src/styles/fonts.css` | Google Fonts import (Barlow Condensed + DM Sans). |
| `theme-tokens.css` | Complete, verified token block, standalone — drop into any codebase. |
| `CLAUDE.md` | Agent-facing brief: reading order, run instructions, non-negotiable visual rules, placeholder-data replacement table, route list, and accessibility gaps. |

### Additional screens (all now built)

**7. Collection detail** (`/collections/:slug`) — slugs: architecture, fantasy, space, ocean, nature, limited-edition, new-arrivals. Breadcrumb, then a 320px hero banner (collection photo at 30% opacity under a left-to-right `#0f0f0f` gradient) carrying an "← All Collections" link, "COLLECTION" eyebrow, 84px title, and description. Below: a toolbar (set count left, Sort select right — Featured / Price low→high / Price high→low / Most Pieces) above a 1px rule, then the 3-up product grid (224px images). `limited-edition` lists the spotlight products; `new-arrivals` filters on `badge === "New"`; all others filter by category. Empty state matches the catalog's.

**8. Checkout** (`/checkout`) — four steps in one route: **cart → shipping → payment → confirmation**.
- **Step indicator** (top right, beside the page title): four 32px circles joined by 72px rules. Completed = filled `#ffd100` with a check; active = yellow ring on `#0f0f0f` with yellow numeral; upcoming = 8%-white ring, gray numeral. Labels 10px tracked beneath.
- **Layout** for steps 1–3: `2fr 1fr` grid, 40px gap, with a **sticky order summary** (`top: 88px`) on the right — line items (56px thumb, name, "Qty n", line amount), then Subtotal / Promo / Shipping / Tax rows and a 20px yellow Total. The promo field appears on the cart step only.
- **Cart step:** bordered, divided line-item list (96px thumb, name, "$X each", stepper, Remove) with a right-aligned line total; "← Continue Shopping" and "Proceed to Shipping ›" beneath. Empty state as in the earlier cart spec.
- **Shipping step:** Contact Information (First/Last/Email/Phone, 2-up), Shipping Address (street, apt, city/state/ZIP 3-up, country), and Shipping Method — three selectable bordered rows (radio dot, label, ETA, price); the selected row takes a `#ffd100` border and `rgba(255,209,0,0.05)` fill.
- **Payment step:** a "Shipping to" summary strip with an Edit link back to step 2; Card Details (name, card number auto-formatted in 4-digit groups, MM/YY expiry, CVV); Billing Address with a "Same as shipping address" checkbox that reveals billing fields when unchecked. Primary button reads "🔒 Place Order — $X.XX".
- **Confirmation:** centered, 512px column — 64px yellow check disc, "ORDER CONFIRMED" eyebrow, "YOU'RE ALL SET" (60px), email confirmation line, a bordered detail block (Order Number / Shipping Method / Estimated Delivery / Total Charged), and Track Order + Continue Shopping buttons. Order number format `ABE-2026-NNNNN`.
- **Checkout math (placeholder — replace with platform rules):** standard shipping free at $75+, otherwise $6.99/$14.99/$29.99 by tier; promo code `ALPINE10` = 10% off; tax 7% of the discounted subtotal.

**9. Support hub** (`/support`) — 2-up grid of five bordered link cards (FAQ, Shipping Info, Returns & Exchanges, Track Your Order, Contact Us), then a yellow-rule callout pointing to Press and commission inquiries.

**10. FAQ** (`/support/faq`) — 768px column. Four topic groups (Orders & Shipping, Products & Building, Returns & Exchanges, Limited Editions & Community), each a yellow 34px heading above a 1px rule followed by an accordion. One panel open at a time; the open panel takes a `rgba(255,209,0,0.4)` border and its chevron rotates 180° to yellow. Closes with a bordered "Still have a question?" CTA.

**11. Shipping Info** (`/support/shipping`) — image page header. "Delivery Options" + 2-up tier cards (Standard / Express / Overnight / International, each with icon, ETA in yellow, price, description, and a small all-caps caveat), then "Good to Know" + a bordered 6-item checklist, then two link cards (Track Your Order / Shipping Issue?).

**12. Returns & Exchanges** (`/support/returns`) — "How It Works" as four numbered cards (the 01–04 numerals are 52px display type in `rgba(255,255,255,0.12)`), then a two-column Eligible (yellow ✓) / Not Eligible (`#e3000b` ✕) split, an "Exchanges" yellow-rule callout, and a "Start a Return →" CTA.

**13. About** (`/about`) — image page header. Origin story: 46px two-line headline (second line yellow) beside a photo with a 96px outlined square offset `-16px` bottom-right; then a 4-up stat band (2021 / 8 / 12K+ / Boulder, CO) between two rules with 40px yellow numerals; "What We Believe" + 2-up value cards; CTA row (Meet the Team / Join the Community).

**14. Our Designers** (`/designers`) — image page header, 1152px column. 3-up team cards: 208px portrait at 60% opacity under a card-colored scrim with a "N yrs experience" chip bottom-left; then yellow specialty eyebrow, 22px name, role, bio, and "Sets Designed" chips. Closes with a bordered, centered "Want to Join the Team?" panel.

**15. Careers** (`/careers`) — image page header. "Current Openings" as three full-width job cards (title, Full-time/location meta row, description, "What We're Looking For" ◆ bullets, "Apply →" button). Then a bordered "Why Work Here" panel with a 2-up ◆ perk list, and a "Don't See Your Role?" yellow-rule callout.

**16. Press Room** (`/press`) — image page header. Two-up top block: a yellow-bordered "Media Inquiries" card (press@alpinebrickexchange.com) beside a centered "Press Kit" download card. Then "Recent Coverage" — five bordered rows, each with an outlet name in yellow + date, headline, excerpt, and an ↗ affordance. Then "Media Assets" — a divided list of five downloadable files with sizes.

**17. Community** (`/community`) — image page header. "Where We Gather" 2-up platform cards (Forum / Discord / Builder Challenges / Events) each ending in a yellow text CTA; "Upcoming Events" as divided rows with Convention (yellow) / Challenge (white) / Local Event (gray) tags; "From the Builders" 3-up testimonial cards (5 yellow stars, italic quote, name, handle, set); closes with the full-width yellow "Ready to Build with Us?" banner.

**18. Contact** (`/support/contact`) — `1fr 2fr` split. Left: "Get in Touch" with three bordered info cards (Email / Response Time / Community) and a yellow-rule note about commission inquiries. Right: a form — Department select (8 options), Name + Email 2-up, optional Order Number, Message textarea, full-width submit. On submit the form is replaced by a yellow-bordered "Message Sent" confirmation echoing the entered email.

**19. Track Order** (`/support/track-order`) — 672px column. Order Number + Email fields and a full-width "Track Order" button. Three result states: **idle** (hint that order numbers look like `ABE-2026-XXXXX`), **not found** (bordered panel + Contact Support), and **found** — a yellow-bordered order card (number, "In Transit" yellow status chip, Item / Carrier / Order Date / Estimated Arrival grid) above a six-step vertical progress timeline (28px circles: completed filled yellow with a check, pending outlined; connector rules yellow at 40% for completed segments). The demo matches any order number containing "ABE".

### Page header component
Pages 9–19 share one header: a breadcrumb bar (10px tracked, 1px bottom rule) above a `rgba(30,30,30,0.2)` band with a 1px bottom rule. With an image: 288px tall, photo at 20% opacity under a left-to-right `#0f0f0f` gradient. Without: 72px vertical padding, no photo. Contents are always yellow eyebrow → 76px display title → optional 576px-max subtitle. Content column widths vary by page (672–1152px) and are listed per screen above.

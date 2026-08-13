import { useState, useEffect, type FormEvent } from 'react'
import { Link, Outlet, useNavigate, useLocation } from 'react-router'
import { ShoppingCart, Menu, X, Search } from 'lucide-react'
import { CartProvider, useCart } from '../lib/cart/CartContext'
import { AlpineBrickLogo } from './Logo'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname])
  return null
}

const NAV_LINKS = [
  { label: 'Collections', to: '/collections' },
  { label: 'New Arrivals', to: '/collections/new-arrivals' },
  { label: 'Limited Edition', to: '/collections/limited-edition' },
  { label: 'About', to: '/about' },
]

function Nav() {
  const { count } = useCart()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  function handleSearch(e: FormEvent) {
    e.preventDefault()
    if (query.trim()) navigate(`/?q=${encodeURIComponent(query.trim())}`)
  }

  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <Link
          to="/"
          className="flex items-center gap-2.5 group outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AlpineBrickLogo size={32} />
          <span
            className="text-xl font-black tracking-[0.12em] uppercase text-foreground group-hover:text-primary transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Alpine Brick
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map(({ label, to }) => (
            <Link
              key={label}
              to={to}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors tracking-[0.16em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSearchOpen(s => !s)}
            className="p-2.5 text-muted-foreground hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Search"
            aria-expanded={searchOpen}
          >
            <Search size={18} aria-hidden />
          </button>
          <Link
            to="/checkout"
            className="relative p-2.5 text-muted-foreground hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={count > 0 ? `Cart, ${count} item${count === 1 ? '' : 's'}` : 'Cart, empty'}
          >
            <ShoppingCart size={18} aria-hidden />
            {count > 0 && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-primary text-primary-foreground text-xs font-black rounded-full flex items-center justify-center"
              >
                {count}
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(s => !s)}
            className="md:hidden p-2.5 text-muted-foreground hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Menu"
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-t border-border px-4 py-3 bg-background">
          <div className="max-w-7xl mx-auto">
            <form onSubmit={handleSearch} role="search">
              <label htmlFor="site-search" className="sr-only">
                Search sets
              </label>
              <input
                id="site-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search sets, themes, piece counts…"
                autoFocus
                className="w-full bg-secondary text-foreground placeholder:text-muted-foreground px-4 py-2.5 text-sm rounded-md border border-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary"
              />
            </form>
          </div>
        </div>
      )}

      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-background px-4 py-5 flex flex-col gap-5">
          {NAV_LINKS.map(({ label, to }) => (
            <Link
              key={label}
              to={to}
              onClick={() => setMobileOpen(false)}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors tracking-[0.16em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  )
}

// Every link here points at a route that exists. The reference footer carried
// a "Gift Cards" entry and a duplicate "Art Series" that went nowhere.
const FOOTER_COLUMNS = [
  {
    heading: 'Shop',
    links: [
      { label: 'All Collections', to: '/collections' },
      { label: 'New Arrivals', to: '/collections/new-arrivals' },
      { label: 'Limited Editions', to: '/collections/limited-edition' },
      { label: 'Architecture', to: '/collections/architecture' },
      { label: 'Fantasy', to: '/collections/fantasy' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'FAQ', to: '/support/faq' },
      { label: 'Shipping Info', to: '/support/shipping' },
      { label: 'Returns', to: '/support/returns' },
      { label: 'Track Order', to: '/support/track-order' },
      { label: 'Contact Us', to: '/support/contact' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About Us', to: '/about' },
      { label: 'Our Designers', to: '/designers' },
      { label: 'Careers', to: '/careers' },
      { label: 'Press', to: '/press' },
      { label: 'Community', to: '/community' },
    ],
  },
]

function Footer() {
  return (
    <footer className="border-t border-border pt-16 pb-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid md:grid-cols-4 gap-12 mb-14">
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <AlpineBrickLogo size={28} />
              <span
                className="text-lg font-black uppercase tracking-[0.15em]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Alpine Brick
              </span>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Custom-designed and collectible brick sets for builders who want more than the
              shelf offers.
            </p>
          </div>
          {FOOTER_COLUMNS.map(col => (
            <div key={col.heading}>
              <div className="font-bold uppercase tracking-[0.18em] text-xs text-foreground mb-4">
                {col.heading}
              </div>
              <ul className="space-y-2.5">
                {col.links.map(link => (
                  <li key={link.label}>
                    <Link
                      to={link.to}
                      className="text-muted-foreground text-sm hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-border pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="text-muted-foreground text-xs">
            © 2026 Alpine Brick Exchange. All rights reserved. Not affiliated with the LEGO Group.
          </div>
          <div className="flex items-center gap-6">
            <Link
              to="/support"
              className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Support
            </Link>
            <Link
              to="/support/contact"
              className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Contact
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}

export default function Root() {
  return (
    <CartProvider>
      <ScrollToTop />
      <div
        className="min-h-screen bg-background text-foreground"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:text-xs focus:font-semibold focus:uppercase focus:tracking-[0.16em]"
        >
          Skip to main content
        </a>
        <Nav />
        <main id="main" className="pt-16">
          <Outlet />
        </main>
        <Footer />
      </div>
    </CartProvider>
  )
}

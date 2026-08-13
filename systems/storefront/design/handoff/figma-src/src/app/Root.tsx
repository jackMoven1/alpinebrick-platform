import { useState, useEffect } from "react";
import { Link, Outlet, useNavigate, useLocation } from "react-router";
import { ShoppingCart, Menu, X, Search } from "lucide-react";
import { CartProvider, useCart } from "./context/CartContext";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);
  return null;
}

function AlpineBrickLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="36" height="36" rx="3" fill="#111111" />
      <circle cx="12" cy="12" r="5.5" fill="#FFD100" />
      <circle cx="24" cy="12" r="5.5" fill="#FFD100" />
      <circle cx="12" cy="24" r="5.5" fill="#FFD100" />
      <circle cx="24" cy="24" r="5.5" fill="#FFD100" />
      <circle cx="12" cy="12" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="24" cy="12" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="12" cy="24" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="24" cy="24" r="2.8" fill="#111111" fillOpacity="0.45" />
    </svg>
  );
}

function Nav() {
  const { count } = useCart();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) navigate(`/?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <Link to="/" className="flex items-center gap-2.5 group">
          <AlpineBrickLogo size={32} />
          <span
            className="text-xl font-black tracking-[0.12em] uppercase text-foreground group-hover:text-primary transition-colors"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Alpine Brick
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {[
            { label: "Collections", to: "/collections" },
            { label: "New Arrivals", to: "/collections/new-arrivals" },
            { label: "Limited Edition", to: "/collections/limited-edition" },
            { label: "About", to: "/about" },
          ].map(({ label, to }) => (
            <Link
              key={label}
              to={to}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors tracking-widest uppercase"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen((s) => !s)}
            className="p-2.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Search"
          >
            <Search size={18} />
          </button>
          <Link
            to="/checkout"
            className="relative p-2.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Cart"
          >
            <ShoppingCart size={18} />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-primary text-primary-foreground text-[10px] font-black rounded-full flex items-center justify-center">
                {count}
              </span>
            )}
          </Link>
          <button
            onClick={() => setMobileOpen((s) => !s)}
            className="md:hidden p-2.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Menu"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-t border-border px-4 py-3 bg-background">
          <div className="max-w-7xl mx-auto">
            <form onSubmit={handleSearch}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sets, themes, piece counts…"
                autoFocus
                className="w-full bg-secondary text-foreground placeholder:text-muted-foreground px-4 py-2.5 text-sm border border-border focus:border-primary outline-none transition-colors"
              />
            </form>
          </div>
        </div>
      )}

      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-background px-4 py-5 flex flex-col gap-5">
          {[
            { label: "Collections", to: "/collections" },
            { label: "New Arrivals", to: "/collections/new-arrivals" },
            { label: "Limited Edition", to: "/collections/limited-edition" },
            { label: "About", to: "/about" },
          ].map(({ label, to }) => (
            <Link
              key={label}
              to={to}
              onClick={() => setMobileOpen(false)}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors tracking-widest uppercase"
            >
              {label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}

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
                style={{ fontFamily: "var(--font-display)" }}
              >
                Alpine Brick
              </span>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Custom-designed LEGO sets for AFOLs and fans who refuse to settle for
              off-the-shelf. Buy, sell, and trade with the community.
            </p>
          </div>
          {[
            {
              heading: "Shop",
              links: [
                { label: "All Collections", to: "/collections" },
                { label: "New Arrivals", to: "/collections/new-arrivals" },
                { label: "Limited Editions", to: "/collections/limited-edition" },
                { label: "Art Series", to: "/collections/limited-edition" },
                { label: "Gift Cards", to: "/" },
              ],
            },
            {
              heading: "Support",
              links: [
                { label: "FAQ", to: "/support/faq" },
                { label: "Shipping Info", to: "/support/shipping" },
                { label: "Returns", to: "/support/returns" },
                { label: "Track Order", to: "/support/track-order" },
                { label: "Contact Us", to: "/support/contact" },
              ],
            },
            {
              heading: "Company",
              links: [
                { label: "About Us", to: "/about" },
                { label: "Our Designers", to: "/designers" },
                { label: "Careers", to: "/careers" },
                { label: "Press", to: "/press" },
                { label: "Community", to: "/community" },
              ],
            },
          ].map((col) => (
            <div key={col.heading}>
              <div className="font-bold uppercase tracking-widest text-[10px] text-foreground mb-4">
                {col.heading}
              </div>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link to={link.to} className="text-muted-foreground text-sm hover:text-foreground transition-colors">
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
            © 2026 Alpine Brick Exchange™. All rights reserved. Not affiliated with the LEGO Group.
          </div>
          <div className="flex items-center gap-6">
            {["Privacy", "Terms", "Cookies"].map((link) => (
              <a key={link} href="#" className="text-muted-foreground text-xs hover:text-foreground transition-colors">
                {link}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function Root() {
  return (
    <CartProvider>
      <ScrollToTop />
      <div className="min-h-screen bg-background text-foreground" style={{ fontFamily: "var(--font-sans)" }}>
        <Nav />
        <main className="pt-16">
          <Outlet />
        </main>
        <Footer />
      </div>
    </CartProvider>
  );
}

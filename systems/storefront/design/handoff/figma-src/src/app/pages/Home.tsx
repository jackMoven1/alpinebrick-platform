import { useState } from "react";
import { Link } from "react-router";
import { Zap, ArrowRight, ChevronRight, Package, Star, Award } from "lucide-react";
import { PRODUCTS, SPOTLIGHTS } from "../data";
import { useCart } from "../context/CartContext";

const CATEGORIES = ["All", "Architecture", "Fantasy", "Space", "Ocean", "Nature"];

const TRUST_ITEMS = [
  "Designed by AFOLs",
  "Free Shipping Over $75",
  "Buy · Sell · Trade",
  "Expert Builder Support",
  "30-Day Returns",
  "Collector Grade Quality",
  "Custom Commission Builds",
  "Limited Runs Only",
];

export default function Home() {
  const { addItem } = useCart();
  const [activeCategory, setActiveCategory] = useState("All");
  const [justAdded, setJustAdded] = useState<number | null>(null);

  const filtered =
    activeCategory === "All"
      ? PRODUCTS
      : PRODUCTS.filter((p) => p.category === activeCategory);

  function handleAdd(id: number, name: string, price: number, image: string) {
    addItem(id, name, price, image);
    setJustAdded(id);
    setTimeout(() => setJustAdded(null), 1600);
  }

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative min-h-[calc(100vh-4rem)] flex items-center overflow-hidden bg-background">
        <div className="absolute inset-0">
          <img
            src="https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1800&h=1000&fit=crop&auto=format"
            alt="Colorful LEGO bricks"
            className="w-full h-full object-cover opacity-15"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-background via-background/75 to-background/20" />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-24 grid md:grid-cols-2 gap-16 items-center w-full">
          <div>
            <div className="inline-flex items-center gap-2 text-primary text-[10px] font-bold tracking-[0.2em] uppercase mb-8 border border-primary/25 px-3 py-1.5">
              <Zap size={11} />
              Designed by AFOLs · Built for Builders
            </div>
            <h1
              className="text-[clamp(4rem,10vw,8rem)] font-black uppercase leading-[0.9] tracking-tight text-foreground mb-8"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Be a<br />
              <span className="text-primary">Master</span><br />
              Builder
            </h1>
            <p className="text-muted-foreground text-lg max-w-md mb-10 leading-relaxed">
              Custom-designed LEGO sets crafted by AFOLs for fans and builders
              who want something truly one of a kind. No two collections alike.
            </p>
            <div className="flex flex-wrap gap-4">
              <a
                href="#catalog"
                className="bg-primary text-primary-foreground font-bold uppercase tracking-[0.15em] px-8 py-4 text-xs hover:bg-primary/85 transition-colors inline-flex items-center gap-2"
              >
                Shop Now <ArrowRight size={14} />
              </a>
              <a
                href="#spotlight"
                className="border border-border text-foreground font-bold uppercase tracking-[0.15em] px-8 py-4 text-xs hover:border-foreground/60 transition-colors"
              >
                View Spotlights
              </a>
            </div>

            <div className="flex items-center gap-10 mt-14 pt-10 border-t border-border">
              {[
                ["500+", "Custom Sets"],
                ["12K+", "Builders"],
                ["4.9", "Avg Rating"],
              ].map(([val, label]) => (
                <div key={label}>
                  <div
                    className="text-3xl font-black text-foreground"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {val}
                    {label === "Avg Rating" && <span className="text-primary text-xl">★</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="hidden md:block relative">
            <div className="relative aspect-[4/5] max-w-sm ml-auto">
              <img
                src="https://images.unsplash.com/photo-1633469924738-52101af51d87?w=640&h=800&fit=crop&auto=format"
                alt="Close-up of colorful LEGO pieces"
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background/90 to-transparent p-6">
                <div
                  className="text-xs font-black uppercase tracking-[0.2em] text-primary mb-1"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  New Drop
                </div>
                <div
                  className="text-xl font-black uppercase text-foreground"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Dragon Fortress
                </div>
                <div className="text-muted-foreground text-xs mt-1">3,156 pieces · $249</div>
              </div>
              <div className="absolute -top-3 -right-3 w-20 h-20 border border-primary/30 pointer-events-none" />
              <div className="absolute -bottom-3 -left-3 w-12 h-12 bg-primary/20 pointer-events-none" />
            </div>
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-muted-foreground">
          <span className="text-[10px] uppercase tracking-widest">Scroll</span>
          <div className="w-px h-10 bg-gradient-to-b from-muted-foreground/60 to-transparent" />
        </div>
      </section>

      {/* ── Trust Bar ─────────────────────────────────────── */}
      <div className="border-y border-border bg-secondary/40 py-3.5 overflow-hidden">
        <div className="flex gap-10 whitespace-nowrap" style={{ animation: "marquee 28s linear infinite" }}>
          {[...TRUST_ITEMS, ...TRUST_ITEMS].map((item, i) => (
            <span
              key={i}
              className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground flex items-center gap-3 flex-shrink-0"
            >
              <span className="text-primary">◆</span> {item}
            </span>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        * { scrollbar-width: none; } *::-webkit-scrollbar { display: none; }
      `}</style>

      {/* ── Spotlight ─────────────────────────────────────── */}
      <section id="spotlight" className="py-28 max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-end justify-between mb-14">
          <div>
            <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">Featured Drops</div>
            <h2
              className="text-5xl md:text-6xl font-black uppercase leading-none"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Spotlight<br />Collection
            </h2>
          </div>
          <a href="#catalog" className="hidden md:flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
            View All <ChevronRight size={14} />
          </a>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {SPOTLIGHTS.map((s) => (
            <div key={s.id} className="group bg-card border border-border hover:border-primary/40 transition-all duration-300 overflow-hidden">
              <Link to={`/product/${s.id}`} className="block relative h-80 overflow-hidden bg-muted">
                <img
                  src={s.images[0]}
                  alt={s.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-card/90 via-card/20 to-transparent" />
                <div className="absolute top-4 left-4">
                  <span className={`text-[10px] font-black uppercase tracking-[0.18em] px-3 py-1.5 ${
                    s.badge === "One of a Kind" ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground"
                  }`}>
                    {s.badge}
                  </span>
                </div>
              </Link>
              <div className="p-7">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1.5">{s.category}</div>
                    <Link to={`/product/${s.id}`}>
                      <h3
                        className="text-2xl font-black uppercase leading-tight hover:text-primary transition-colors"
                        style={{ fontFamily: "var(--font-display)" }}
                      >
                        {s.name}
                      </h3>
                    </Link>
                  </div>
                  <div className="text-right ml-4 flex-shrink-0">
                    <div className="text-3xl font-black" style={{ fontFamily: "var(--font-display)" }}>
                      ${s.price}
                    </div>
                    <div className="text-muted-foreground text-[10px] mt-0.5">{s.pieces.toLocaleString()} pieces</div>
                  </div>
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed mb-6">{s.description}</p>
                <div className="flex gap-3">
                  <Link
                    to={`/product/${s.id}`}
                    className="flex-1 border border-border text-foreground font-bold uppercase tracking-[0.12em] py-3 text-xs hover:border-primary hover:text-primary transition-colors text-center"
                  >
                    View Details
                  </Link>
                  <button
                    onClick={() => handleAdd(s.id, s.name, s.price, s.images[0])}
                    className={`flex-1 font-bold uppercase tracking-[0.12em] py-3 text-xs transition-all duration-300 ${
                      justAdded === s.id
                        ? "bg-accent text-accent-foreground"
                        : "bg-primary text-primary-foreground hover:bg-primary/85"
                    }`}
                  >
                    {justAdded === s.id ? "Added ✓" : "Add to Cart"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Full Catalog ──────────────────────────────────── */}
      <section id="catalog" className="py-28 border-t border-border bg-secondary/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="mb-10">
            <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">Browse the Build</div>
            <h2
              className="text-5xl md:text-6xl font-black uppercase leading-none"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Full<br />Catalog
            </h2>
          </div>

          <div className="flex flex-wrap gap-2 mb-12">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2 text-[10px] font-bold uppercase tracking-[0.18em] border transition-all ${
                  activeCategory === cat
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {filtered.length > 0 ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {filtered.map((product) => (
                <div
                  key={product.id}
                  className="group bg-card border border-border hover:border-primary/35 transition-all duration-300 overflow-hidden"
                >
                  <Link to={`/product/${product.id}`} className="block relative h-52 overflow-hidden bg-muted">
                    <img
                      src={product.images[0]}
                      alt={product.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                    {product.badge && (
                      <div className="absolute top-3 left-3">
                        <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 ${
                          product.badge === "Limited"
                            ? "bg-primary text-primary-foreground"
                            : product.badge === "New"
                            ? "bg-accent text-accent-foreground"
                            : "bg-foreground text-background"
                        }`}>
                          {product.badge}
                        </span>
                      </div>
                    )}
                  </Link>
                  <div className="p-5">
                    <div className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1.5">{product.category}</div>
                    <Link to={`/product/${product.id}`}>
                      <h3
                        className="text-xl font-black uppercase leading-tight mb-2 hover:text-primary transition-colors"
                        style={{ fontFamily: "var(--font-display)" }}
                      >
                        {product.name}
                      </h3>
                    </Link>
                    <p className="text-muted-foreground text-xs leading-relaxed mb-5 line-clamp-2">{product.description}</p>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-2xl font-black" style={{ fontFamily: "var(--font-display)" }}>
                          ${product.price}
                        </div>
                        <div className="text-muted-foreground text-[10px] mt-0.5">{product.pieces.toLocaleString()} pieces</div>
                      </div>
                      <div className="flex gap-2">
                        <Link
                          to={`/product/${product.id}`}
                          className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] border border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                        >
                          Details
                        </Link>
                        <button
                          onClick={() => handleAdd(product.id, product.name, product.price, product.images[0])}
                          className={`px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-all duration-300 ${
                            justAdded === product.id
                              ? "bg-accent text-accent-foreground"
                              : "bg-primary text-primary-foreground hover:bg-primary/85"
                          }`}
                        >
                          {justAdded === product.id ? "Added ✓" : "Add"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-28 text-muted-foreground">
              <Package size={40} className="mx-auto mb-5 opacity-25" />
              <p className="text-xs uppercase tracking-widest">No sets in this category yet — check back soon</p>
            </div>
          )}
        </div>
      </section>

      {/* ── Why Alpine Brick ──────────────────────────────── */}
      <section className="py-28 max-w-7xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-14">
          <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">What Sets Us Apart</div>
          <h2
            className="text-5xl md:text-6xl font-black uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Why Alpine<br />Brick Exchange
          </h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6 mt-14">
          {[
            {
              icon: <Award size={26} />,
              title: "Exclusively Designed",
              body: "Every set originates with our AFOL design team — builders who live and breathe the hobby. Created for the community, by the community. You won't find these anywhere else.",
            },
            {
              icon: <Package size={26} />,
              title: "Collector-Grade Quality",
              body: "Premium packaging, numbered certificates of authenticity, and brick quality you can feel from the first stud. Built to display and built to last generations.",
            },
            {
              icon: <Star size={26} />,
              title: "Drops That Matter",
              body: "We release new sets when they're ready, not on a timetable. Sign up to get early access to limited runs before they open to the general community.",
            },
          ].map((item) => (
            <div key={item.title} className="border border-border p-8 hover:border-primary/35 transition-colors group">
              <div className="text-primary mb-5 group-hover:text-accent transition-colors">{item.icon}</div>
              <h3
                className="text-xl font-black uppercase mb-3"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {item.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Newsletter ────────────────────────────────────── */}
      <section className="py-28 bg-primary relative overflow-hidden border-t border-border">
        <div className="absolute inset-0 opacity-10">
          <img
            src="https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1600&h=700&fit=crop&auto=format"
            alt=""
            aria-hidden
            className="w-full h-full object-cover"
          />
        </div>
        <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 text-center">
          <h2
            className="text-5xl md:text-7xl font-black uppercase text-primary-foreground mb-5 leading-none"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Join the<br />Exchange
          </h2>
          <p className="text-primary-foreground/75 mb-10 text-base leading-relaxed">
            Early access to limited drops, builder-to-builder trade listings,
            and exclusive community challenges — all for AFOLs, by AFOLs.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
            <input
              type="email"
              placeholder="your@email.com"
              className="flex-1 bg-primary-foreground/10 border border-primary-foreground/25 text-primary-foreground placeholder:text-primary-foreground/45 px-4 py-3 text-sm outline-none focus:border-primary-foreground transition-colors"
            />
            <button className="bg-primary-foreground text-primary font-black uppercase tracking-[0.15em] px-7 py-3 text-xs hover:bg-primary-foreground/90 transition-colors whitespace-nowrap">
              Join Now
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

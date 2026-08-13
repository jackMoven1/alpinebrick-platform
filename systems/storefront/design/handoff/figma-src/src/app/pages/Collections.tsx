import { Link } from "react-router";
import { ChevronRight, ArrowRight } from "lucide-react";
import { ALL_PRODUCTS, PRODUCTS, SPOTLIGHTS } from "../data";

const COLLECTIONS = [
  {
    slug: "architecture",
    label: "Architecture",
    description:
      "Skylines, landmarks, and urban landscapes rendered in meticulous brick detail. Sets that look as good on a shelf as they do in a display case.",
    image: "https://images.unsplash.com/photo-1774223638287-021fed6e3b3d?w=800&h=600&fit=crop&auto=format",
  },
  {
    slug: "fantasy",
    label: "Fantasy",
    description:
      "Castles, dragons, enchanted temples, and worlds that never existed — until now. Our most ambitious builds live here.",
    image: "https://images.unsplash.com/photo-1633469924738-52101af51d87?w=800&h=600&fit=crop&auto=format",
  },
  {
    slug: "space",
    label: "Space",
    description:
      "From retro golden-age orbiters to deep-future exploration rigs. Sets inspired by humanity's reach beyond the atmosphere.",
    image: "https://images.unsplash.com/photo-1620309668391-26ac1c90f61b?w=800&h=600&fit=crop&auto=format",
  },
  {
    slug: "ocean",
    label: "Ocean",
    description:
      "Submarines, research stations, and the mysteries of the deep. Builds that capture the pressure and beauty of the underwater world.",
    image: "https://images.unsplash.com/photo-1631106254201-ffbee2305c5b?w=800&h=600&fit=crop&auto=format",
  },
  {
    slug: "nature",
    label: "Nature",
    description:
      "Mountain railways, alpine landscapes, and the quiet grandeur of the natural world translated into brick.",
    image: "https://images.unsplash.com/photo-1644175897056-50f4d3a9a827?w=800&h=600&fit=crop&auto=format",
  },
  {
    slug: "limited-edition",
    label: "Limited Edition",
    description:
      "One-of-a-kind sets produced in strictly limited runs. Once they're gone, they're gone. Collector certificates included.",
    image: "https://images.unsplash.com/photo-1764557257729-78a549bf2929?w=800&h=600&fit=crop&auto=format",
  },
];

function productCountForSlug(slug: string) {
  if (slug === "limited-edition") return SPOTLIGHTS.length;
  const label = COLLECTIONS.find((c) => c.slug === slug)?.label ?? "";
  return PRODUCTS.filter((p) => p.category === label).length;
}

export default function Collections() {
  const totalSets = ALL_PRODUCTS.length;

  return (
    <div className="min-h-screen bg-background">
      {/* Page header */}
      <div className="border-b border-border bg-secondary/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
          <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
          <ChevronRight size={10} />
          <span className="text-foreground">Collections</span>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        {/* Hero */}
        <div className="py-20 border-b border-border grid md:grid-cols-2 gap-8 items-end">
          <div>
            <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-4">Browse by Theme</div>
            <h1
              className="text-6xl md:text-8xl font-black uppercase leading-none"
              style={{ fontFamily: "var(--font-display)" }}
            >
              All<br />
              <span className="text-primary">Collec</span>tions
            </h1>
          </div>
          <div className="md:text-right">
            <p className="text-muted-foreground leading-relaxed mb-4 max-w-sm md:ml-auto">
              {COLLECTIONS.length} themed collections, {totalSets} unique sets — all designed
              in-house by our AFOL team and produced in limited quantities.
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              View Full Catalog <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        {/* Collections grid */}
        <div className="py-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {COLLECTIONS.map((col) => {
            const count = productCountForSlug(col.slug);
            return (
              <Link
                key={col.slug}
                to={`/collections/${col.slug}`}
                className="group bg-card border border-border hover:border-primary/40 transition-all duration-300 overflow-hidden block"
              >
                {/* Image */}
                <div className="relative h-52 overflow-hidden bg-muted">
                  <img
                    src={col.image}
                    alt={col.label}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 opacity-80 group-hover:opacity-100"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-card/80 to-transparent" />
                  <div className="absolute bottom-4 left-4">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground bg-background/70 backdrop-blur-sm px-2.5 py-1 border border-border">
                      {count} {count === 1 ? "set" : "sets"}
                    </span>
                  </div>
                </div>

                {/* Info */}
                <div className="p-6">
                  <div className="flex items-start justify-between mb-3">
                    <h2
                      className="text-2xl font-black uppercase leading-tight group-hover:text-primary transition-colors"
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {col.label}
                    </h2>
                    <ChevronRight
                      size={18}
                      className="text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all flex-shrink-0 mt-1"
                    />
                  </div>
                  <p className="text-muted-foreground text-sm leading-relaxed">{col.description}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

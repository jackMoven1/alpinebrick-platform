import { useState } from "react";
import { Link, useParams, Navigate } from "react-router";
import { ChevronRight, ArrowLeft, Package } from "lucide-react";
import { PRODUCTS, SPOTLIGHTS } from "../data";
import { useCart } from "../context/CartContext";

const COLLECTION_META: Record<
  string,
  { label: string; description: string; image: string }
> = {
  architecture: {
    label: "Architecture",
    description:
      "Skylines, landmarks, and urban landscapes rendered in meticulous brick detail.",
    image: "https://images.unsplash.com/photo-1774223638287-021fed6e3b3d?w=1600&h=500&fit=crop&auto=format",
  },
  fantasy: {
    label: "Fantasy",
    description:
      "Castles, dragons, enchanted temples, and worlds that never existed — until now.",
    image: "https://images.unsplash.com/photo-1633469924738-52101af51d87?w=1600&h=500&fit=crop&auto=format",
  },
  space: {
    label: "Space",
    description:
      "Retro orbiters to deep-future exploration rigs, inspired by humanity's reach beyond the atmosphere.",
    image: "https://images.unsplash.com/photo-1620309668391-26ac1c90f61b?w=1600&h=500&fit=crop&auto=format",
  },
  ocean: {
    label: "Ocean",
    description:
      "Submarines, research stations, and the mysteries of the underwater world in brick.",
    image: "https://images.unsplash.com/photo-1631106254201-ffbee2305c5b?w=1600&h=500&fit=crop&auto=format",
  },
  nature: {
    label: "Nature",
    description:
      "Mountain railways, alpine landscapes, and the quiet grandeur of the natural world.",
    image: "https://images.unsplash.com/photo-1644175897056-50f4d3a9a827?w=1600&h=500&fit=crop&auto=format",
  },
  "limited-edition": {
    label: "Limited Edition",
    description:
      "One-of-a-kind sets produced in strictly limited runs with numbered certificates. Once gone, gone forever.",
    image: "https://images.unsplash.com/photo-1764557257729-78a549bf2929?w=1600&h=500&fit=crop&auto=format",
  },
  "new-arrivals": {
    label: "New Arrivals",
    description:
      "The latest additions to the Alpine Brick catalog — fresh drops from our AFOL design team.",
    image: "https://images.unsplash.com/photo-1765403256661-c60b291c38ba?w=1600&h=500&fit=crop&auto=format",
  },
};

const SORT_OPTIONS = [
  { value: "featured", label: "Featured" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "pieces-desc", label: "Most Pieces" },
];

export default function CollectionDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { addItem } = useCart();
  const [sort, setSort] = useState("featured");
  const [justAdded, setJustAdded] = useState<number | null>(null);

  const meta = slug ? COLLECTION_META[slug] : null;
  if (!meta) return <Navigate to="/collections" replace />;

  const baseProducts =
    slug === "limited-edition"
      ? SPOTLIGHTS
      : slug === "new-arrivals"
      ? PRODUCTS.filter((p) => p.badge === "New")
      : PRODUCTS.filter((p) => p.category === meta.label);

  const sorted = [...baseProducts].sort((a, b) => {
    if (sort === "price-asc") return a.price - b.price;
    if (sort === "price-desc") return b.price - a.price;
    if (sort === "pieces-desc") return b.pieces - a.pieces;
    return 0;
  });

  function handleAdd(id: number, name: string, price: number, image: string) {
    addItem(id, name, price, image);
    setJustAdded(id);
    setTimeout(() => setJustAdded(null), 1600);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Breadcrumb */}
      <div className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
          <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
          <ChevronRight size={10} />
          <Link to="/collections" className="hover:text-foreground transition-colors">Collections</Link>
          <ChevronRight size={10} />
          <span className="text-foreground">{meta.label}</span>
        </div>
      </div>

      {/* Collection hero banner */}
      <div className="relative h-64 md:h-80 overflow-hidden bg-muted">
        <img
          src={meta.image}
          alt={meta.label}
          className="w-full h-full object-cover opacity-30"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/60 to-transparent" />
        <div className="absolute inset-0 flex items-center">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 w-full">
            <Link
              to="/collections"
              className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
              <ArrowLeft size={12} /> All Collections
            </Link>
            <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">Collection</div>
            <h1
              className="text-5xl md:text-7xl font-black uppercase leading-none text-foreground"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {meta.label}
            </h1>
            <p className="text-muted-foreground mt-4 max-w-lg">{meta.description}</p>
          </div>
        </div>
      </div>

      {/* Product grid */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-border">
          <span className="text-muted-foreground text-sm">
            <span className="text-foreground font-bold">{sorted.length}</span>{" "}
            {sorted.length === 1 ? "set" : "sets"}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs uppercase tracking-widest hidden sm:block">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="bg-secondary border border-border text-foreground text-xs uppercase tracking-widest px-3 py-2 outline-none focus:border-primary transition-colors cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {sorted.length > 0 ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {sorted.map((product) => (
              <div
                key={product.id}
                className="group bg-card border border-border hover:border-primary/35 transition-all duration-300 overflow-hidden"
              >
                <Link to={`/product/${product.id}`} className="block relative h-56 overflow-hidden bg-muted">
                  <img
                    src={product.images[0]}
                    alt={product.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                  />
                  {product.badge && (
                    <div className="absolute top-3 left-3">
                      <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 ${
                        product.badge === "Limited" || product.badge === "One of a Kind"
                          ? "bg-primary text-primary-foreground"
                          : product.badge === "New" || product.badge === "Designer Series"
                          ? "bg-accent text-accent-foreground"
                          : "bg-foreground text-background"
                      }`}>
                        {product.badge}
                      </span>
                    </div>
                  )}
                </Link>
                <div className="p-5">
                  <div className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1.5">
                    {product.category}
                  </div>
                  <Link to={`/product/${product.id}`}>
                    <h3
                      className="text-xl font-black uppercase leading-tight mb-2 hover:text-primary transition-colors"
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {product.name}
                    </h3>
                  </Link>
                  <p className="text-muted-foreground text-xs leading-relaxed mb-5 line-clamp-2">
                    {product.description}
                  </p>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-2xl font-black" style={{ fontFamily: "var(--font-display)" }}>
                        ${product.price}
                      </div>
                      <div className="text-muted-foreground text-[10px] mt-0.5">
                        {product.pieces.toLocaleString()} pieces
                      </div>
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
          <div className="text-center py-32 text-muted-foreground">
            <Package size={40} className="mx-auto mb-5 opacity-25" />
            <p className="text-xs uppercase tracking-widest">No sets in this collection yet — check back soon</p>
          </div>
        )}
      </div>
    </div>
  );
}

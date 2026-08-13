import { useState } from "react";
import { Link, useParams, Navigate } from "react-router";
import {
  ChevronRight,
  ShoppingCart,
  ArrowLeft,
  Star,
  Check,
  Package,
  Layers,
  Clock,
  Ruler,
  Hash,
  Users,
  ChevronLeft,
} from "lucide-react";
import { ALL_PRODUCTS, PRODUCTS } from "../data";
import { useCart } from "../context/CartContext";

type Tab = "overview" | "inbox" | "notes";

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { addItem } = useCart();

  const product = ALL_PRODUCTS.find((p) => p.id === Number(id));

  const [activeImage, setActiveImage] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  if (!product) return <Navigate to="/" replace />;

  const related = PRODUCTS.filter(
    (p) => p.id !== product.id && p.category === product.category
  ).slice(0, 3);

  const fallbackRelated = PRODUCTS.filter((p) => p.id !== product.id).slice(0, 3);
  const relatedProducts = related.length > 0 ? related : fallbackRelated;

  function handleAdd() {
    for (let i = 0; i < qty; i++) {
      addItem(product.id, product.name, product.price, product.images[0]);
    }
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }

  const difficultyColor = {
    Beginner: "text-green-400",
    Intermediate: "text-primary",
    Advanced: "text-orange-400",
    Expert: "text-red-400",
  }[product.difficulty];

  const badgeStyle =
    product.badge === "Limited" || product.badge === "One of a Kind"
      ? "bg-primary text-primary-foreground"
      : product.badge === "New" || product.badge === "Designer Series"
      ? "bg-accent text-accent-foreground"
      : "bg-foreground text-background";

  return (
    <div className="min-h-screen bg-background">
      {/* Breadcrumb */}
      <div className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
          <Link to="/" className="hover:text-foreground transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> Home
          </Link>
          <ChevronRight size={10} />
          <span className="hover:text-foreground transition-colors cursor-pointer">{product.category}</span>
          <ChevronRight size={10} />
          <span className="text-foreground truncate max-w-[200px]">{product.name}</span>
        </div>
      </div>

      {/* Main product section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid lg:grid-cols-2 gap-12 xl:gap-20">

          {/* ── Image Gallery ── */}
          <div className="lg:sticky lg:top-24 self-start">
            {/* Main image */}
            <div className="relative aspect-[4/3] bg-muted overflow-hidden mb-3">
              <img
                src={product.images[activeImage]}
                alt={`${product.name} — view ${activeImage + 1}`}
                className="w-full h-full object-cover transition-opacity duration-300"
              />
              {product.badge && (
                <div className="absolute top-4 left-4">
                  <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1.5 ${badgeStyle}`}>
                    {product.badge}
                  </span>
                </div>
              )}
              {/* Prev/Next arrows */}
              {product.images.length > 1 && (
                <>
                  <button
                    onClick={() => setActiveImage((i) => (i - 1 + product.images.length) % product.images.length)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-background/80 backdrop-blur-sm border border-border flex items-center justify-center text-foreground hover:bg-background transition-colors"
                    aria-label="Previous image"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    onClick={() => setActiveImage((i) => (i + 1) % product.images.length)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-background/80 backdrop-blur-sm border border-border flex items-center justify-center text-foreground hover:bg-background transition-colors"
                    aria-label="Next image"
                  >
                    <ChevronRight size={16} />
                  </button>
                </>
              )}
              {/* Image counter */}
              <div className="absolute bottom-4 right-4 bg-background/80 backdrop-blur-sm border border-border px-2.5 py-1 text-[10px] font-bold text-foreground">
                {activeImage + 1} / {product.images.length}
              </div>
            </div>

            {/* Thumbnails */}
            <div className="grid grid-cols-4 gap-2">
              {product.images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setActiveImage(i)}
                  className={`aspect-square overflow-hidden border-2 transition-all ${
                    activeImage === i ? "border-primary" : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <img src={img} alt={`View ${i + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>

            {/* Set number */}
            <div className="mt-4 flex items-center gap-2 text-muted-foreground text-[10px] uppercase tracking-widest">
              <Hash size={11} />
              Set {product.setNumber}
            </div>
          </div>

          {/* ── Product Info ── */}
          <div>
            {/* Category + rating */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-primary text-[10px] font-bold uppercase tracking-[0.2em]">
                {product.category}
              </span>
              <div className="flex items-center gap-1.5">
                <div className="flex">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      size={13}
                      className={i < Math.floor(product.rating) ? "text-primary fill-primary" : "text-border"}
                    />
                  ))}
                </div>
                <span className="text-muted-foreground text-xs">
                  {product.rating} ({product.reviewCount} reviews)
                </span>
              </div>
            </div>

            {/* Name */}
            <h1
              className="text-4xl md:text-5xl font-black uppercase leading-tight mb-4"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {product.name}
            </h1>

            {/* Price + pieces */}
            <div className="flex items-end gap-4 mb-8 pb-8 border-b border-border">
              <div
                className="text-5xl font-black text-foreground"
                style={{ fontFamily: "var(--font-display)" }}
              >
                ${product.price}
              </div>
              <div className="pb-1.5">
                <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
                  <Layers size={14} />
                  {product.pieces.toLocaleString()} pieces
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-0.5">
                  <Users size={12} />
                  Ages {product.ageRecommendation}
                </div>
              </div>
            </div>

            {/* Spec grid */}
            <div className="grid grid-cols-2 gap-3 mb-8">
              {[
                {
                  icon: <Clock size={13} />,
                  label: "Difficulty",
                  value: (
                    <span className={`font-bold ${difficultyColor}`}>{product.difficulty}</span>
                  ),
                },
                {
                  icon: <Ruler size={13} />,
                  label: "Assembled Size",
                  value: product.dimensions,
                },
                {
                  icon: <Layers size={13} />,
                  label: "Piece Count",
                  value: product.pieces.toLocaleString(),
                },
                {
                  icon: <Package size={13} />,
                  label: "Set Number",
                  value: product.setNumber,
                },
              ].map((spec) => (
                <div key={spec.label} className="bg-secondary/40 border border-border px-4 py-3">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-widest mb-1">
                    {spec.icon} {spec.label}
                  </div>
                  <div className="text-sm font-semibold text-foreground">{spec.value}</div>
                </div>
              ))}
            </div>

            {/* Short description */}
            <p className="text-muted-foreground leading-relaxed mb-8">
              {product.description}
            </p>

            {/* Qty + Add to cart */}
            <div className="flex gap-3 mb-8">
              <div className="flex items-center border border-border">
                <button
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  className="px-4 py-3 text-muted-foreground hover:text-foreground transition-colors font-bold text-lg"
                >
                  −
                </button>
                <span className="px-4 py-3 text-sm font-bold text-foreground min-w-[3rem] text-center">
                  {qty}
                </span>
                <button
                  onClick={() => setQty((q) => q + 1)}
                  className="px-4 py-3 text-muted-foreground hover:text-foreground transition-colors font-bold text-lg"
                >
                  +
                </button>
              </div>
              <button
                onClick={handleAdd}
                className={`flex-1 flex items-center justify-center gap-2 font-black uppercase tracking-[0.15em] py-3 text-sm transition-all duration-300 ${
                  added
                    ? "bg-accent text-accent-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/85"
                }`}
              >
                {added ? (
                  <>
                    <Check size={16} /> Added to Cart
                  </>
                ) : (
                  <>
                    <ShoppingCart size={16} /> Add to Cart
                  </>
                )}
              </button>
            </div>

            {/* Trust micro-copy */}
            <div className="flex flex-wrap gap-4 pb-8 mb-8 border-b border-border">
              {["Free shipping over $75", "30-day returns", "Numbered certificate included"].map((item) => (
                <div key={item} className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Check size={12} className="text-primary flex-shrink-0" />
                  {item}
                </div>
              ))}
            </div>

            {/* ── Tabs ── */}
            <div>
              <div className="flex border-b border-border mb-6">
                {(
                  [
                    ["overview", "Overview"],
                    ["inbox", "In the Box"],
                    ["notes", "Builder Notes"],
                  ] as [Tab, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`px-5 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-all -mb-px ${
                      activeTab === key
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {activeTab === "overview" && (
                <div>
                  <p className="text-muted-foreground leading-relaxed mb-6 text-sm">
                    {product.longDescription}
                  </p>
                  <ul className="space-y-3">
                    {product.features.map((f) => (
                      <li key={f} className="flex items-start gap-3 text-sm">
                        <Check size={14} className="text-primary flex-shrink-0 mt-0.5" />
                        <span className="text-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {activeTab === "inbox" && (
                <ul className="space-y-3">
                  {product.includes.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm">
                      <span className="text-primary font-black flex-shrink-0">◆</span>
                      <span className="text-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              )}

              {activeTab === "notes" && (
                <div className="border-l-2 border-primary pl-5">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-primary font-bold mb-3">
                    From the Design Team
                  </div>
                  <p className="text-muted-foreground leading-relaxed text-sm italic">
                    "{product.builderNotes}"
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Related Products ── */}
      {relatedProducts.length > 0 && (
        <section className="border-t border-border py-20 bg-secondary/20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex items-end justify-between mb-10">
              <div>
                <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-2">
                  You Might Also Like
                </div>
                <h2
                  className="text-3xl font-black uppercase"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Related Sets
                </h2>
              </div>
              <Link
                to="/"
                className="text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2"
              >
                View All <ChevronRight size={14} />
              </Link>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {relatedProducts.map((p) => (
                <Link
                  key={p.id}
                  to={`/product/${p.id}`}
                  className="group bg-card border border-border hover:border-primary/35 transition-all duration-300 overflow-hidden block"
                >
                  <div className="relative h-44 overflow-hidden bg-muted">
                    <img
                      src={p.images[0]}
                      alt={p.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                  </div>
                  <div className="p-5">
                    <div className="text-muted-foreground text-[10px] uppercase tracking-widest mb-1">{p.category}</div>
                    <h3
                      className="text-lg font-black uppercase leading-tight mb-1 group-hover:text-primary transition-colors"
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {p.name}
                    </h3>
                    <div className="flex items-center justify-between mt-3">
                      <div className="text-2xl font-black" style={{ fontFamily: "var(--font-display)" }}>
                        ${p.price}
                      </div>
                      <div className="text-muted-foreground text-[10px]">{p.pieces.toLocaleString()} pcs</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

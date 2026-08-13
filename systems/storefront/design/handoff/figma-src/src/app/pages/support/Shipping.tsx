import { Truck, Zap, Globe, Package, Clock, Check } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const TIERS = [
  {
    icon: <Package size={24} />,
    name: "Standard Shipping",
    time: "5–7 Business Days",
    price: "Free over $75 · $6.99 under",
    description: "Our default shipping method via USPS or UPS Ground. Tracking included on every order.",
    note: "Best for non-urgent orders.",
  },
  {
    icon: <Zap size={24} />,
    name: "Express Shipping",
    time: "2–3 Business Days",
    price: "$14.99",
    description: "Priority handling and expedited carrier routing. Orders placed before 12 PM ET ship same day.",
    note: "Available for all domestic US addresses.",
  },
  {
    icon: <Truck size={24} />,
    name: "Overnight",
    time: "Next Business Day",
    price: "$29.99",
    description: "Guaranteed next-business-day delivery for orders placed before 12 PM ET Monday–Friday.",
    note: "Not available for PO Boxes or certain rural routes.",
  },
  {
    icon: <Globe size={24} />,
    name: "International",
    time: "10–18 Business Days",
    price: "Calculated at checkout",
    description: "We ship to 40+ countries via DHL and USPS International. Rates vary by destination and package weight.",
    note: "Customs duties and import taxes are the recipient's responsibility.",
  },
];

const NOTES = [
  "All orders are processed and shipped from our Colorado facility.",
  "Orders placed Monday–Friday before 12 PM ET typically ship the same day.",
  "Weekend orders are processed the following Monday.",
  "Large sets (3,000+ pieces) may require an additional 1–2 business days for careful packaging.",
  "Limited edition sets ship with white-glove packaging and signature confirmation.",
  "You'll receive a tracking email the moment your order leaves our facility.",
];

export default function Shipping() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support", to: "/support" }, { label: "Shipping Info" }]}
        eyebrow="Support"
        title="Shipping Info"
        subtitle="We ship every order with care. Here's everything you need to know about delivery options and timelines."
        image="https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Shipping tiers */}
        <h2
          className="text-3xl font-black uppercase mb-8"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Delivery Options
        </h2>
        <div className="grid sm:grid-cols-2 gap-4 mb-16">
          {TIERS.map((tier) => (
            <div key={tier.name} className="border border-border p-6 hover:border-primary/35 transition-colors group">
              <div className="text-primary mb-4 group-hover:text-accent transition-colors">{tier.icon}</div>
              <h3
                className="text-xl font-black uppercase mb-1"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {tier.name}
              </h3>
              <div className="flex items-center gap-2 mb-3">
                <Clock size={12} className="text-muted-foreground" />
                <span className="text-primary text-xs font-bold uppercase tracking-widest">{tier.time}</span>
                <span className="text-muted-foreground text-xs">·</span>
                <span className="text-muted-foreground text-xs">{tier.price}</span>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed mb-3">{tier.description}</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">{tier.note}</p>
            </div>
          ))}
        </div>

        {/* General notes */}
        <h2
          className="text-3xl font-black uppercase mb-6"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Good to Know
        </h2>
        <div className="border border-border divide-y divide-border">
          {NOTES.map((note) => (
            <div key={note} className="flex items-start gap-4 px-6 py-4">
              <Check size={14} className="text-primary flex-shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">{note}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 grid sm:grid-cols-2 gap-4">
          <a
            href="/support/track-order"
            className="border border-border p-6 hover:border-primary/35 transition-colors text-center group block"
          >
            <Truck size={24} className="mx-auto mb-3 text-muted-foreground group-hover:text-primary transition-colors" />
            <div className="font-black uppercase text-sm" style={{ fontFamily: "var(--font-display)" }}>Track Your Order</div>
            <p className="text-muted-foreground text-xs mt-1">Enter your order number to get live tracking</p>
          </a>
          <a
            href="/support/contact"
            className="border border-border p-6 hover:border-primary/35 transition-colors text-center group block"
          >
            <Package size={24} className="mx-auto mb-3 text-muted-foreground group-hover:text-primary transition-colors" />
            <div className="font-black uppercase text-sm" style={{ fontFamily: "var(--font-display)" }}>Shipping Issue?</div>
            <p className="text-muted-foreground text-xs mt-1">Contact our team and we'll sort it out</p>
          </a>
        </div>
      </div>
    </div>
  );
}

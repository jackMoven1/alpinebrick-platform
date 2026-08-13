import { useState } from "react";
import { Search, Package, Truck, Check, Clock } from "lucide-react";
import PageHeader from "../../components/PageHeader";

type Status = "idle" | "loading" | "found" | "not-found";

const MOCK_ORDER = {
  number: "ABE-2026-08421",
  product: "Mountain Railway Express",
  placed: "August 7, 2026",
  status: "In Transit",
  eta: "August 13, 2026",
  carrier: "UPS",
  tracking: "1Z999AA10123456784",
  steps: [
    { label: "Order Placed", date: "Aug 7, 2026", done: true },
    { label: "Payment Confirmed", date: "Aug 7, 2026", done: true },
    { label: "Packed & Dispatched", date: "Aug 8, 2026", done: true },
    { label: "In Transit", date: "Aug 9, 2026", done: true },
    { label: "Out for Delivery", date: "Est. Aug 13, 2026", done: false },
    { label: "Delivered", date: "Est. Aug 13, 2026", done: false },
  ],
};

export default function TrackOrder() {
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setStatus("loading");
    setTimeout(() => {
      setStatus(query.toUpperCase().includes("ABE") ? "found" : "not-found");
    }, 1200);
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support", to: "/support" }, { label: "Track Order" }]}
        eyebrow="Support"
        title="Track Your Order"
        subtitle="Enter your order number and email to get live tracking information."
      />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
        {/* Search form */}
        <form onSubmit={handleSubmit} className="mb-12">
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                Order Number
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. ABE-2026-08421"
                className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="The email used at checkout"
                className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full bg-primary text-primary-foreground font-black uppercase tracking-widest py-3 text-xs hover:bg-primary/85 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {status === "loading" ? (
                <span className="animate-pulse">Searching…</span>
              ) : (
                <><Search size={14} /> Track Order</>
              )}
            </button>
          </div>
        </form>

        {/* Not found */}
        {status === "not-found" && (
          <div className="border border-border p-8 text-center">
            <Package size={36} className="mx-auto mb-4 text-muted-foreground opacity-40" />
            <h3 className="font-black uppercase text-lg mb-2" style={{ fontFamily: "var(--font-display)" }}>
              Order Not Found
            </h3>
            <p className="text-muted-foreground text-sm leading-relaxed mb-6">
              We couldn't find an order matching that number and email. Double-check the details or contact our support team.
            </p>
            <a
              href="/support/contact"
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-bold uppercase tracking-widest px-5 py-2.5 text-xs hover:bg-primary/85 transition-colors"
            >
              Contact Support
            </a>
          </div>
        )}

        {/* Found */}
        {status === "found" && (
          <div>
            <div className="border border-primary/40 p-6 mb-8">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Order</div>
                  <div className="font-black text-lg" style={{ fontFamily: "var(--font-display)" }}>
                    {MOCK_ORDER.number}
                  </div>
                </div>
                <span className="bg-primary text-primary-foreground text-[10px] font-black uppercase tracking-widest px-3 py-1.5 flex items-center gap-1.5">
                  <Truck size={11} /> {MOCK_ORDER.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Item</div>
                  <div className="font-semibold text-foreground">{MOCK_ORDER.product}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Carrier</div>
                  <div className="font-semibold text-foreground">{MOCK_ORDER.carrier} · {MOCK_ORDER.tracking}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Order Date</div>
                  <div className="font-semibold text-foreground">{MOCK_ORDER.placed}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">Estimated Arrival</div>
                  <div className="font-semibold text-primary">{MOCK_ORDER.eta}</div>
                </div>
              </div>
            </div>

            {/* Progress timeline */}
            <h3 className="text-xl font-black uppercase mb-6" style={{ fontFamily: "var(--font-display)" }}>
              Shipment Progress
            </h3>
            <div className="space-y-0">
              {MOCK_ORDER.steps.map((step, i) => (
                <div key={step.label} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      step.done ? "bg-primary border-primary" : "bg-background border-border"
                    }`}>
                      {step.done ? (
                        <Check size={13} className="text-primary-foreground" />
                      ) : (
                        <Clock size={13} className="text-muted-foreground" />
                      )}
                    </div>
                    {i < MOCK_ORDER.steps.length - 1 && (
                      <div className={`w-px flex-1 my-1 ${step.done ? "bg-primary/40" : "bg-border"}`} style={{ minHeight: "2rem" }} />
                    )}
                  </div>
                  <div className="pb-6">
                    <div className={`font-semibold text-sm ${step.done ? "text-foreground" : "text-muted-foreground"}`}>
                      {step.label}
                    </div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">{step.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {status === "idle" && (
          <p className="text-center text-muted-foreground text-xs">
            Your order number appears in your confirmation email — look for something like{" "}
            <span className="text-foreground font-mono">ABE-2026-XXXXX</span>.
          </p>
        )}
      </div>
    </div>
  );
}

import { Check, X, ArrowRight } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const STEPS = [
  {
    number: "01",
    title: "Initiate Your Return",
    body: "Email support@alpinebrickexchange.com with your order number and reason for return. You can also use the Contact form. We respond within 1 business day.",
  },
  {
    number: "02",
    title: "Receive Your Prepaid Label",
    body: "We'll email you a prepaid return shipping label. No cost to you. Print it and attach it securely to the outside of the original packaging.",
  },
  {
    number: "03",
    title: "Drop Off Your Package",
    body: "Drop the package at any USPS or UPS location. Keep your receipt — it includes a tracking number so you can confirm we've received it.",
  },
  {
    number: "04",
    title: "Receive Your Refund",
    body: "Once we receive and inspect the return (typically within 2 business days of arrival), your refund is issued to the original payment method within 5–7 business days.",
  },
];

const ELIGIBLE = [
  "Unopened sets in original packaging within 30 days of delivery",
  "Sets with manufacturing defects (opened packaging accepted)",
  "Wrong item received",
  "Sets damaged in transit — contact us with photos within 72 hours",
];

const NOT_ELIGIBLE = [
  "Limited edition and collector's edition sets (all sales final)",
  "Opened sets without a manufacturing defect",
  "Sets returned after 30 days from delivery",
  "Sets missing original packaging, certificates, or accessories",
  "Commission builds",
];

export default function Returns() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support", to: "/support" }, { label: "Returns" }]}
        eyebrow="Support"
        title="Returns & Exchanges"
        subtitle="30-day returns on unopened sets. We make it simple."
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
        {/* Process steps */}
        <h2
          className="text-3xl font-black uppercase mb-10"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How It Works
        </h2>
        <div className="grid sm:grid-cols-2 gap-6 mb-16">
          {STEPS.map((step) => (
            <div key={step.number} className="border border-border p-6 relative">
              <div
                className="text-5xl font-black text-border mb-4 leading-none"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {step.number}
              </div>
              <h3
                className="text-lg font-black uppercase mb-2"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {step.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>

        {/* Eligibility */}
        <div className="grid sm:grid-cols-2 gap-6 mb-16">
          <div>
            <h2
              className="text-2xl font-black uppercase mb-6 text-foreground"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Eligible for Return
            </h2>
            <ul className="space-y-3">
              {ELIGIBLE.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <Check size={14} className="text-primary flex-shrink-0 mt-0.5" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2
              className="text-2xl font-black uppercase mb-6 text-foreground"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Not Eligible
            </h2>
            <ul className="space-y-3">
              {NOT_ELIGIBLE.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <X size={14} className="text-destructive flex-shrink-0 mt-0.5" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Exchange note */}
        <div className="border-l-2 border-primary pl-6 mb-16">
          <h3
            className="text-xl font-black uppercase mb-2"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Exchanges
          </h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Exchanges follow the same process as returns. Once we receive your item, we'll ship the replacement with priority handling at no additional shipping charge. If the set you want is out of stock, we'll issue a full refund or store credit — your choice.
          </p>
        </div>

        <a
          href="/support/contact"
          className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors"
        >
          Start a Return <ArrowRight size={14} />
        </a>
      </div>
    </div>
  );
}

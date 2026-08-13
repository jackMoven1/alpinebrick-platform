import { useState } from "react";
import { ChevronDown } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const FAQ_SECTIONS = [
  {
    topic: "Orders & Shipping",
    items: [
      {
        q: "How long does shipping take?",
        a: "Standard shipping takes 5–7 business days within the contiguous US. Express (2–3 days) and overnight options are available at checkout. International orders typically arrive in 10–18 business days depending on destination and customs clearance.",
      },
      {
        q: "Do you ship internationally?",
        a: "Yes — we ship to over 40 countries. International shipping rates and estimated delivery times are calculated at checkout based on your location. Note that customs duties and import taxes are the responsibility of the recipient.",
      },
      {
        q: "How will I know when my order has shipped?",
        a: "You'll receive a shipping confirmation email with a tracking number as soon as your order leaves our facility. You can also track your order anytime at alpinebrickexchange.com/support/track-order.",
      },
      {
        q: "Can I change or cancel my order after placing it?",
        a: "Orders can be modified or cancelled within 2 hours of placement by contacting our support team. After that window, orders enter production fulfillment and cannot be changed. Limited edition orders are final at the time of purchase.",
      },
    ],
  },
  {
    topic: "Products & Building",
    items: [
      {
        q: "Are your sets compatible with standard LEGO bricks?",
        a: "Yes. All Alpine Brick sets use standard-dimension bricks that are fully compatible with official LEGO sets and any other brand using the standard stud specification.",
      },
      {
        q: "What if I'm missing a piece?",
        a: "Every order includes a 5% parts surplus above the listed piece count for the most commonly misplaced elements. If you're still missing something after the build, contact us with your set number and the missing part ID — we'll ship a replacement at no charge within 10 business days.",
      },
      {
        q: "How difficult are the builds?",
        a: "Each set is rated on a four-tier scale: Beginner (10+), Intermediate (12+), Advanced (14+), and Expert (16+). Difficulty ratings are listed on every product page and consider technique complexity, piece count, and build duration.",
      },
      {
        q: "Do the sets come with building instructions?",
        a: "Every set includes a printed, full-color illustrated builder's guide. Page counts range from 148 pages (Retro Space Station) to 420 pages (Dragon Fortress). Digital PDF versions are available in your account after purchase.",
      },
    ],
  },
  {
    topic: "Returns & Exchanges",
    items: [
      {
        q: "What is your return policy?",
        a: "We accept returns within 30 days of delivery for sets in original, unopened packaging. Opened sets can be returned if a manufacturing defect is the reason. Limited edition sets are final sale and cannot be returned.",
      },
      {
        q: "How do I start a return?",
        a: "Visit our Returns page or contact support@alpinebrickexchange.com with your order number and reason for return. We'll provide a prepaid return label within 1 business day. Refunds are issued within 5–7 business days of receiving the returned item.",
      },
      {
        q: "Can I exchange for a different set?",
        a: "Yes — exchanges are processed the same way as returns. After we receive your return, we'll ship the replacement set with priority handling at no additional shipping charge.",
      },
    ],
  },
  {
    topic: "Limited Editions & Community",
    items: [
      {
        q: "How do limited edition drops work?",
        a: "Limited edition sets are announced to our email subscribers first, typically 48 hours before public release. Units are strictly capped and once sold out, are not restocked. Joining the Builders Guild mailing list is the best way to secure your spot.",
      },
      {
        q: "Can I trade or sell my sets?",
        a: "Absolutely — that's part of what the Exchange is about. Our community forum has a dedicated buy/sell/trade section. We also run community events where builders can swap parts, complete sets, and custom builds.",
      },
      {
        q: "Do you take commission build requests?",
        a: "We accept a limited number of commission builds per quarter. Commissions start at $350 and require a 4–8 week production window. Fill out the commission inquiry form on our Contact page to get the conversation started.",
      },
    ],
  },
];

export default function FAQ() {
  const [open, setOpen] = useState<string | null>(null);

  function toggle(key: string) {
    setOpen((prev) => (prev === key ? null : key));
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support", to: "/support" }, { label: "FAQ" }]}
        eyebrow="Support"
        title="Frequently Asked Questions"
        subtitle="Everything you need to know about ordering, building, and the Alpine Brick community."
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
        {FAQ_SECTIONS.map((section) => (
          <div key={section.topic} className="mb-12">
            <h2
              className="text-2xl font-black uppercase text-primary mb-6 pb-3 border-b border-border"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {section.topic}
            </h2>
            <div className="space-y-2">
              {section.items.map((item) => {
                const key = `${section.topic}-${item.q}`;
                const isOpen = open === key;
                return (
                  <div key={key} className={`border transition-colors ${isOpen ? "border-primary/40" : "border-border"}`}>
                    <button
                      onClick={() => toggle(key)}
                      className="w-full flex items-center justify-between px-5 py-4 text-left gap-4"
                    >
                      <span className="font-semibold text-sm text-foreground">{item.q}</span>
                      <ChevronDown
                        size={16}
                        className={`text-muted-foreground flex-shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180 text-primary" : ""}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-5">
                        <p className="text-muted-foreground text-sm leading-relaxed">{item.a}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="border border-border p-8 text-center mt-8">
          <p className="text-muted-foreground text-sm mb-4">Still have a question?</p>
          <a
            href="/support/contact"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors"
          >
            Contact Support
          </a>
        </div>
      </div>
    </div>
  );
}

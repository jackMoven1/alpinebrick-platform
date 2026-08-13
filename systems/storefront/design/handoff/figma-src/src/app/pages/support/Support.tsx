import { Link } from "react-router";
import { MessageSquare, Truck, RotateCcw, Search, Phone, ChevronRight } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const LINKS = [
  {
    icon: <MessageSquare size={24} />,
    title: "FAQ",
    description: "Answers to the most common questions about orders, products, and the community.",
    to: "/support/faq",
  },
  {
    icon: <Truck size={24} />,
    title: "Shipping Info",
    description: "Delivery options, timelines, international shipping, and what to expect.",
    to: "/support/shipping",
  },
  {
    icon: <RotateCcw size={24} />,
    title: "Returns & Exchanges",
    description: "Our 30-day return policy and step-by-step exchange process.",
    to: "/support/returns",
  },
  {
    icon: <Search size={24} />,
    title: "Track Your Order",
    description: "Enter your order number to get live shipping and delivery updates.",
    to: "/support/track-order",
  },
  {
    icon: <Phone size={24} />,
    title: "Contact Us",
    description: "Reach our support team directly. We respond within one business day.",
    to: "/support/contact",
  },
];

export default function Support() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support" }]}
        eyebrow="Help Center"
        title="Support"
        subtitle="How can we help? Find answers below or reach our team directly."
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
        <div className="grid sm:grid-cols-2 gap-4">
          {LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group border border-border hover:border-primary/40 transition-all duration-300 p-6 flex items-start gap-5"
            >
              <div className="text-primary group-hover:text-accent transition-colors flex-shrink-0 mt-0.5">
                {item.icon}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <h3
                    className="text-lg font-black uppercase group-hover:text-primary transition-colors"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {item.title}
                  </h3>
                  <ChevronRight size={16} className="text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">{item.description}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-12 border-l-2 border-primary pl-6">
          <p className="text-muted-foreground text-sm leading-relaxed">
            For press and media inquiries, visit our{" "}
            <Link to="/press" className="text-primary hover:underline font-semibold">Press Room</Link>.
            For commission build requests, use the{" "}
            <Link to="/support/contact" className="text-primary hover:underline font-semibold">Contact form</Link>{" "}
            and select "Commission Build Inquiry."
          </p>
        </div>
      </div>
    </div>
  );
}

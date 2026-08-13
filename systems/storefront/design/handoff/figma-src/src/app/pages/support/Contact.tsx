import { useState } from "react";
import { Send, Check, Mail, Clock, MessageSquare } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const DEPARTMENTS = [
  "Order Support",
  "Shipping & Tracking",
  "Returns & Exchanges",
  "Product Questions",
  "Commission Build Inquiry",
  "Press & Media",
  "Community & Events",
  "Other",
];

type FormState = "idle" | "sending" | "sent";

export default function Contact() {
  const [dept, setDept] = useState(DEPARTMENTS[0]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [order, setOrder] = useState("");
  const [message, setMessage] = useState("");
  const [formState, setFormState] = useState<FormState>("idle");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormState("sending");
    setTimeout(() => setFormState("sent"), 1400);
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Support", to: "/support" }, { label: "Contact Us" }]}
        eyebrow="Support"
        title="Contact Us"
        subtitle="Our team typically responds within one business day."
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 grid md:grid-cols-3 gap-12">
        {/* Sidebar info */}
        <div>
          <h2 className="text-xl font-black uppercase mb-6" style={{ fontFamily: "var(--font-display)" }}>
            Get in Touch
          </h2>
          <div className="space-y-6">
            {[
              {
                icon: <Mail size={18} />,
                label: "Email",
                value: "support@alpinebrickexchange.com",
                sub: "For all order and product questions",
              },
              {
                icon: <Clock size={18} />,
                label: "Response Time",
                value: "Within 1 Business Day",
                sub: "Mon–Fri, 9 AM–5 PM MT",
              },
              {
                icon: <MessageSquare size={18} />,
                label: "Community",
                value: "Forum & Discord",
                sub: "Peer support from the builder community",
              },
            ].map((item) => (
              <div key={item.label} className="border border-border p-4">
                <div className="text-primary mb-2">{item.icon}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">{item.label}</div>
                <div className="font-semibold text-sm text-foreground">{item.value}</div>
                <div className="text-muted-foreground text-xs mt-0.5">{item.sub}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 border-l-2 border-primary pl-4">
            <p className="text-muted-foreground text-xs leading-relaxed">
              For commission build inquiries, please select "Commission Build Inquiry" from the department dropdown and include as much detail as possible about your vision.
            </p>
          </div>
        </div>

        {/* Form */}
        <div className="md:col-span-2">
          {formState === "sent" ? (
            <div className="border border-primary/40 p-12 text-center h-full flex flex-col items-center justify-center">
              <div className="w-14 h-14 bg-primary rounded-full flex items-center justify-center mx-auto mb-5">
                <Check size={24} className="text-primary-foreground" />
              </div>
              <h3 className="text-2xl font-black uppercase mb-3" style={{ fontFamily: "var(--font-display)" }}>
                Message Sent
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
                Thanks for reaching out. We'll get back to you at <strong className="text-foreground">{email}</strong> within one business day.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                  Department
                </label>
                <select
                  value={dept}
                  onChange={(e) => setDept(e.target.value)}
                  className="w-full bg-secondary border border-border text-foreground text-sm px-4 py-3 outline-none focus:border-primary transition-colors cursor-pointer"
                >
                  {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
                </select>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                    Your Name
                  </label>
                  <input
                    required
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="First and last name"
                    className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                    Email Address
                  </label>
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                  Order Number <span className="text-muted-foreground/50">(optional)</span>
                </label>
                <input
                  type="text"
                  value={order}
                  onChange={(e) => setOrder(e.target.value)}
                  placeholder="ABE-2026-XXXXX"
                  className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
                  Message
                </label>
                <textarea
                  required
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tell us how we can help…"
                  rows={6}
                  className="w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors resize-none"
                />
              </div>

              <button
                type="submit"
                disabled={formState === "sending"}
                className="w-full bg-primary text-primary-foreground font-black uppercase tracking-widest py-3.5 text-xs hover:bg-primary/85 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {formState === "sending" ? (
                  <span className="animate-pulse">Sending…</span>
                ) : (
                  <><Send size={14} /> Send Message</>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

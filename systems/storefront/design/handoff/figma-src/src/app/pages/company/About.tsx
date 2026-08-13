import { ArrowRight } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const VALUES = [
  {
    title: "Community First",
    body: "Every design decision starts with the same question: would an AFOL love this? Not a focus group. Not a trend report. An actual adult fan of LEGO who knows the hobby from the inside.",
  },
  {
    title: "No Compromises",
    body: "We don't ship sets until we're proud of them. That's meant delaying launches, scrapping near-finished designs, and restarting builds from scratch. We'd rather do it right than do it fast.",
  },
  {
    title: "Built to Last",
    body: "Our sets are engineered to be displayed, handled, and played with — not to sit in a cupboard. Every structural element is load-tested. Collector-grade quality isn't a marketing claim; it's an engineering standard.",
  },
  {
    title: "Transparent by Default",
    body: "We share our design process publicly, publish piece counts and difficulty ratings honestly, and tell you exactly what's in every box before you buy. No surprises.",
  },
];

export default function About() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "About Us" }]}
        eyebrow="Our Story"
        title="About Alpine Brick Exchange"
        image="https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Origin story */}
        <div className="grid md:grid-cols-2 gap-12 items-start mb-20">
          <div>
            <h2
              className="text-4xl font-black uppercase leading-tight mb-6"
              style={{ fontFamily: "var(--font-display)" }}
            >
              We Built This<br />
              <span className="text-primary">Because We Had To</span>
            </h2>
            <div className="space-y-4 text-muted-foreground text-sm leading-relaxed">
              <p>
                Alpine Brick Exchange started at a kitchen table in Boulder, Colorado, in 2021. Three AFOLs — a structural engineer, a graphic designer, and a former toy industry product manager — kept buying sets that were almost what they wanted, and kept making the same decision: to build it themselves instead.
              </p>
              <p>
                The first set took eleven months. We gave away 40 copies to the local AFOL community, took their feedback, rebuilt it, and gave away 40 more. By the third iteration, people were asking where they could buy one.
              </p>
              <p>
                That's the whole origin story. No venture capital. No brand strategy. Just three builders who wanted better sets and didn't know when to stop improving them.
              </p>
            </div>
          </div>
          <div className="relative">
            <img
              src="https://images.unsplash.com/photo-1765403256661-c60b291c38ba?w=700&h=600&fit=crop&auto=format"
              alt="Colorful brick collection"
              className="w-full object-cover"
            />
            <div className="absolute -bottom-4 -right-4 border border-primary/30 w-24 h-24 pointer-events-none" />
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-20 border-y border-border py-12">
          {[
            ["2021", "Founded"],
            ["8", "Sets Launched"],
            ["12K+", "Builders Worldwide"],
            ["Boulder, CO", "Home Base"],
          ].map(([val, label]) => (
            <div key={label} className="text-center">
              <div
                className="text-4xl font-black text-primary"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {val}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* Values */}
        <h2
          className="text-4xl font-black uppercase mb-10"
          style={{ fontFamily: "var(--font-display)" }}
        >
          What We Believe
        </h2>
        <div className="grid sm:grid-cols-2 gap-6 mb-16">
          {VALUES.map((v) => (
            <div key={v.title} className="border border-border p-6 hover:border-primary/35 transition-colors">
              <h3
                className="text-lg font-black uppercase mb-3"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {v.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{v.body}</p>
            </div>
          ))}
        </div>

        {/* CTA row */}
        <div className="flex flex-wrap gap-4">
          <a
            href="/designers"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors"
          >
            Meet the Team <ArrowRight size={14} />
          </a>
          <a
            href="/community"
            className="inline-flex items-center gap-2 border border-border text-foreground font-bold uppercase tracking-widest px-6 py-3 text-xs hover:border-foreground/60 transition-colors"
          >
            Join the Community
          </a>
        </div>
      </div>
    </div>
  );
}

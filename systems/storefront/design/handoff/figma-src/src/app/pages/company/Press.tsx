import { Download, ExternalLink, ArrowRight } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const COVERAGE = [
  {
    outlet: "Brick Fanatics",
    headline: "Alpine Brick Exchange Is Making the LEGO Sets the Community Always Wanted",
    date: "March 2026",
    excerpt: "What started in a Boulder kitchen has become one of the most talked-about names in the AFOL community. Their Dragon Fortress set has a waiting list.",
    url: "#",
  },
  {
    outlet: "The Brothers Brick",
    headline: "Review: Mountain Railway Express — An Expert-Grade Build Worth Every Hour",
    date: "January 2026",
    excerpt: "The load-bearing viaduct alone is worth the price of admission. But it's the 14-grey-variant cliff face that'll stop you mid-build to simply look.",
    url: "#",
  },
  {
    outlet: "Wired",
    headline: "The LEGO Aftermarket Is Growing Up — And These Indie Studios Are Leading It",
    date: "November 2025",
    excerpt: "A new generation of AFOL-founded companies is producing sets that rival — and in some ways exceed — what you'll find in any official catalog.",
    url: "#",
  },
  {
    outlet: "Toy World Magazine",
    headline: "Five Indie Brick Companies to Watch in 2026",
    date: "December 2025",
    excerpt: "Alpine Brick Exchange tops our list for production quality, community engagement, and the sheer ambition of their design pipeline.",
    url: "#",
  },
  {
    outlet: "AFOL Magazine",
    headline: "The Art of the Builder's Guide: Yuki Tanaka on Making Instructions Worth Reading",
    date: "September 2025",
    excerpt: "Inside the philosophy behind the most celebrated instruction booklets in the independent LEGO set market.",
    url: "#",
  },
];

const ASSETS = [
  { name: "Logo Pack (SVG, PNG, Dark/Light)", size: "2.4 MB" },
  { name: "Product Photography — Full Catalog", size: "118 MB" },
  { name: "Founders Headshots", size: "14 MB" },
  { name: "Brand Guidelines PDF", size: "4.1 MB" },
  { name: "Company Fact Sheet", size: "0.8 MB" },
];

export default function Press() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Press" }]}
        eyebrow="Media & Press"
        title="Press Room"
        subtitle="Resources and coverage for journalists, bloggers, and media partners."
        image="https://images.unsplash.com/photo-1760883786219-166f9a0398f1?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Press contact */}
        <div className="grid md:grid-cols-3 gap-6 mb-16">
          <div className="md:col-span-2 border border-primary/40 p-6">
            <div className="text-primary text-[10px] font-bold uppercase tracking-widest mb-3">Press Contact</div>
            <h3 className="text-2xl font-black uppercase mb-2" style={{ fontFamily: "var(--font-display)" }}>
              Media Inquiries
            </h3>
            <p className="text-muted-foreground text-sm leading-relaxed mb-4">
              For interview requests, product review samples, and press credentials for LEGO fan events, contact our media team directly. We respond to all media inquiries within one business day.
            </p>
            <div className="text-sm">
              <span className="text-muted-foreground">Email: </span>
              <a href="mailto:press@alpinebrickexchange.com" className="text-primary font-semibold hover:underline">
                press@alpinebrickexchange.com
              </a>
            </div>
          </div>
          <div className="border border-border p-6 flex flex-col justify-center items-center text-center">
            <Download size={28} className="text-muted-foreground mb-3" />
            <h3 className="font-black uppercase text-lg mb-2" style={{ fontFamily: "var(--font-display)" }}>Press Kit</h3>
            <p className="text-muted-foreground text-xs mb-4 leading-relaxed">Logos, photos, guidelines, and fact sheet — all in one download.</p>
            <a
              href="#"
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-bold uppercase tracking-widest px-4 py-2.5 text-xs hover:bg-primary/85 transition-colors"
            >
              <Download size={12} /> Download Kit
            </a>
          </div>
        </div>

        {/* Media coverage */}
        <h2 className="text-3xl font-black uppercase mb-8" style={{ fontFamily: "var(--font-display)" }}>
          Recent Coverage
        </h2>
        <div className="space-y-4 mb-16">
          {COVERAGE.map((item) => (
            <a
              key={item.headline}
              href={item.url}
              className="block border border-border hover:border-primary/35 transition-colors p-6 group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-primary text-[10px] font-black uppercase tracking-widest">{item.outlet}</span>
                    <span className="text-muted-foreground text-[10px]">·</span>
                    <span className="text-muted-foreground text-[10px] uppercase tracking-widest">{item.date}</span>
                  </div>
                  <h3 className="font-bold text-foreground group-hover:text-primary transition-colors text-sm leading-snug mb-2">
                    {item.headline}
                  </h3>
                  <p className="text-muted-foreground text-xs leading-relaxed">{item.excerpt}</p>
                </div>
                <ExternalLink size={14} className="text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 mt-1" />
              </div>
            </a>
          ))}
        </div>

        {/* Media assets */}
        <h2 className="text-3xl font-black uppercase mb-6" style={{ fontFamily: "var(--font-display)" }}>
          Media Assets
        </h2>
        <div className="border border-border divide-y divide-border mb-12">
          {ASSETS.map((asset) => (
            <div key={asset.name} className="flex items-center justify-between px-6 py-4 hover:bg-secondary/20 transition-colors group">
              <div>
                <div className="font-semibold text-sm text-foreground">{asset.name}</div>
                <div className="text-muted-foreground text-[10px] mt-0.5">{asset.size}</div>
              </div>
              <a href="#" className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground group-hover:text-primary transition-colors">
                <Download size={12} /> Download
              </a>
            </div>
          ))}
        </div>

        <a href="/support/contact" className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
          Other media requests → Contact Us <ArrowRight size={12} />
        </a>
      </div>
    </div>
  );
}

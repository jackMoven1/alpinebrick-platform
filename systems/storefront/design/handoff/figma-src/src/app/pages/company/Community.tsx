import { ArrowRight, Users, MessageSquare, Calendar, Trophy, Star } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const PLATFORMS = [
  {
    icon: <MessageSquare size={24} />,
    name: "Community Forum",
    description: "The main hub for discussion, build showcases, buy/sell/trade listings, and set feedback. Over 4,200 active members.",
    action: "Visit Forum",
    url: "#",
  },
  {
    icon: <Users size={24} />,
    name: "Discord Server",
    description: "Real-time chat for builders, dedicated channels for each set, sneak peek drops, and direct access to our design team during office hours.",
    action: "Join Discord",
    url: "#",
  },
  {
    icon: <Trophy size={24} />,
    name: "Builder Challenges",
    description: "Monthly building challenges with themes chosen by the community. Winners receive store credit and early access to upcoming sets.",
    action: "See Current Challenge",
    url: "#",
  },
  {
    icon: <Calendar size={24} />,
    name: "Events & Conventions",
    description: "We attend BrickFair, Bricks by the Bay, BrickWorld, and regional AFOL events throughout the year. Come find us at the table.",
    action: "View Event Calendar",
    url: "#",
  },
];

const UPCOMING_EVENTS = [
  { name: "BrickWorld Chicago", date: "September 12–14, 2026", location: "Schaumburg, IL", type: "Convention" },
  { name: "Alpine Brick Build Night — Boulder", date: "August 22, 2026", location: "Boulder, CO", type: "Local Event" },
  { name: "Community Build Challenge #14 Deadline", date: "August 31, 2026", location: "Online", type: "Challenge" },
  { name: "BrickFair Virginia", date: "October 3–5, 2026", location: "Chantilly, VA", type: "Convention" },
];

const TESTIMONIALS = [
  {
    quote: "The Dragon Fortress is the most satisfying 40 hours I've spent at a table. The secret passages took me four and a half hours to find. Worth every minute.",
    name: "R. Howell",
    handle: "@brickwright_rob",
    set: "Dragon Fortress",
  },
  {
    quote: "Mountain Railway Express has permanently taken up a third of my desk. My partner is very understanding. The viaduct is genuinely structural art.",
    name: "T. Inoue",
    handle: "@tinoue_builds",
    set: "Mountain Railway Express",
  },
  {
    quote: "I've built sets from every major independent studio. Alpine Brick's builder guides are in a different class. Yuki's sequencing is practically meditative.",
    name: "C. Oduya",
    handle: "@coduya_afol",
    set: "Millennium City Skyline",
  },
];

export default function Community() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Community" }]}
        eyebrow="The Exchange"
        title="Community"
        subtitle="Alpine Brick Exchange is a company, but the Exchange is bigger than us. It's the builders."
        image="https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Platforms */}
        <h2 className="text-3xl font-black uppercase mb-8" style={{ fontFamily: "var(--font-display)" }}>
          Where We Gather
        </h2>
        <div className="grid sm:grid-cols-2 gap-4 mb-20">
          {PLATFORMS.map((p) => (
            <div key={p.name} className="border border-border p-6 hover:border-primary/35 transition-colors group">
              <div className="text-primary mb-4 group-hover:text-accent transition-colors">{p.icon}</div>
              <h3 className="text-xl font-black uppercase mb-2" style={{ fontFamily: "var(--font-display)" }}>
                {p.name}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-5">{p.description}</p>
              <a
                href={p.url}
                className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary hover:text-primary/80 transition-colors"
              >
                {p.action} <ArrowRight size={12} />
              </a>
            </div>
          ))}
        </div>

        {/* Upcoming events */}
        <h2 className="text-3xl font-black uppercase mb-6" style={{ fontFamily: "var(--font-display)" }}>
          Upcoming Events
        </h2>
        <div className="border border-border divide-y divide-border mb-20">
          {UPCOMING_EVENTS.map((event) => (
            <div key={event.name} className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 hover:bg-secondary/20 transition-colors">
              <div>
                <div className="font-semibold text-sm text-foreground">{event.name}</div>
                <div className="text-muted-foreground text-xs mt-0.5">{event.location}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 ${
                  event.type === "Convention"
                    ? "bg-primary text-primary-foreground"
                    : event.type === "Challenge"
                    ? "bg-accent text-accent-foreground"
                    : "bg-secondary border border-border text-muted-foreground"
                }`}>
                  {event.type}
                </span>
                <span className="text-muted-foreground text-xs uppercase tracking-widest">{event.date}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Builder testimonials */}
        <h2 className="text-3xl font-black uppercase mb-8" style={{ fontFamily: "var(--font-display)" }}>
          From the Builders
        </h2>
        <div className="grid md:grid-cols-3 gap-4 mb-16">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="border border-border p-6">
              <div className="flex mb-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} size={12} className="text-primary fill-primary" />
                ))}
              </div>
              <blockquote className="text-muted-foreground text-sm leading-relaxed mb-4 italic">
                "{t.quote}"
              </blockquote>
              <div>
                <div className="font-bold text-xs text-foreground">{t.name}</div>
                <div className="text-muted-foreground text-[10px] uppercase tracking-widest">{t.handle}</div>
                <div className="text-primary text-[10px] mt-1 uppercase tracking-widest">{t.set}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Join CTA */}
        <div className="bg-primary p-10 text-center relative overflow-hidden">
          <div className="absolute inset-0 opacity-10">
            <img
              src="https://images.unsplash.com/photo-1633469924738-52101af51d87?w=1000&h=400&fit=crop&auto=format"
              alt=""
              aria-hidden
              className="w-full h-full object-cover"
            />
          </div>
          <div className="relative z-10">
            <h3 className="text-4xl font-black uppercase text-primary-foreground mb-3" style={{ fontFamily: "var(--font-display)" }}>
              Ready to Build with Us?
            </h3>
            <p className="text-primary-foreground/75 text-sm mb-6 max-w-md mx-auto">
              Join 12,000+ builders in the Exchange. Free to join — just bring your enthusiasm.
            </p>
            <div className="flex flex-wrap gap-3 justify-center">
              <a href="#" className="inline-flex items-center gap-2 bg-primary-foreground text-primary font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary-foreground/90 transition-colors">
                Join the Forum <ArrowRight size={14} />
              </a>
              <a href="#" className="inline-flex items-center gap-2 border border-primary-foreground/40 text-primary-foreground font-bold uppercase tracking-widest px-6 py-3 text-xs hover:border-primary-foreground transition-colors">
                Join Discord
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

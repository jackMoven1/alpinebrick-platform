import { MapPin, Clock, ArrowRight } from "lucide-react";
import PageHeader from "../../components/PageHeader";

const OPENINGS = [
  {
    title: "Senior Build Designer — Fantasy & Adventure",
    type: "Full-time",
    location: "Boulder, CO (on-site)",
    description:
      "We're looking for a designer with a proven track record in large-scale fantasy builds — castles, creatures, and environments. You'll own set concepts from sketch through final QA and work directly with our structural team on mechanism integration.",
    requirements: [
      "5+ years experience designing AFOL-level builds",
      "Strong portfolio of fantasy or historical architecture builds",
      "Familiarity with SNOT techniques and Technic integration",
      "Experience working within piece count and cost constraints",
    ],
  },
  {
    title: "Instruction Designer & Technical Writer",
    type: "Full-time",
    location: "Boulder, CO or Remote",
    description:
      "You'll own the illustrated builder's guide for every new set — from build sequence logic through final print-ready layout. Our guides are a product in themselves, and this role requires equal parts technical precision and visual storytelling ability.",
    requirements: [
      "Experience designing step-by-step build instructions",
      "Proficiency in vector illustration and layout software (Illustrator, InDesign, or equivalent)",
      "Strong written communication skills",
      "Brick-building experience at an intermediate level or above",
    ],
  },
  {
    title: "Community & Events Manager",
    type: "Part-time · Contract",
    location: "Remote",
    description:
      "We need someone to grow and steward our builder community — managing the forum, coordinating Discord events, running builder challenges, and representing Alpine Brick at LEGO fan conventions. This role is the public face of the Exchange community.",
    requirements: [
      "Active AFOL community participation",
      "Experience managing online communities (Discord, forum platforms)",
      "Clear, engaging written communication",
      "Ability to travel to 3–5 LEGO fan events per year",
    ],
  },
];

const PERKS = [
  "Full set library access — every Alpine Brick set, yours to keep",
  "Flexible hours built around build cycles, not 9-to-5",
  "Health, dental, and vision (full-time roles)",
  "Annual LEGO parts budget ($500/yr, no questions asked)",
  "Attendance at major LEGO fan conventions on Alpine Brick",
  "Profit-sharing on sets you lead",
];

export default function Careers() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Careers" }]}
        eyebrow="Join the Studio"
        title="Careers"
        subtitle="We're a small team. Every hire changes the studio. We take that seriously."
        image="https://images.unsplash.com/photo-1644175897056-50f4d3a9a827?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
        {/* Current openings */}
        <h2 className="text-3xl font-black uppercase mb-8" style={{ fontFamily: "var(--font-display)" }}>
          Current Openings
        </h2>
        <div className="space-y-4 mb-20">
          {OPENINGS.map((job) => (
            <div key={job.title} className="border border-border hover:border-primary/35 transition-colors p-6 group">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div>
                  <h3
                    className="text-xl font-black uppercase leading-tight group-hover:text-primary transition-colors"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {job.title}
                  </h3>
                  <div className="flex items-center gap-4 mt-2">
                    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                      <Clock size={11} /> {job.type}
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                      <MapPin size={11} /> {job.location}
                    </span>
                  </div>
                </div>
                <a
                  href="/support/contact"
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-bold uppercase tracking-widest px-4 py-2 text-xs hover:bg-primary/85 transition-colors flex-shrink-0"
                >
                  Apply <ArrowRight size={12} />
                </a>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">{job.description}</p>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">What We're Looking For</div>
                <ul className="space-y-1.5">
                  {job.requirements.map((req) => (
                    <li key={req} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className="text-primary mt-0.5 flex-shrink-0">◆</span> {req}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>

        {/* Perks */}
        <div className="border border-border p-8 mb-12">
          <h2 className="text-3xl font-black uppercase mb-6" style={{ fontFamily: "var(--font-display)" }}>
            Why Work Here
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {PERKS.map((perk) => (
              <div key={perk} className="flex items-start gap-3 text-sm">
                <span className="text-primary mt-0.5 flex-shrink-0">◆</span>
                <span className="text-muted-foreground">{perk}</span>
              </div>
            ))}
          </div>
        </div>

        {/* No role listed */}
        <div className="border-l-2 border-primary pl-6">
          <h3 className="text-xl font-black uppercase mb-2" style={{ fontFamily: "var(--font-display)" }}>
            Don't See Your Role?
          </h3>
          <p className="text-muted-foreground text-sm leading-relaxed mb-4">
            We occasionally hire for roles we haven't posted yet. If you're a serious AFOL builder with a skill you think the studio needs, introduce yourself through our Contact page. We read every email.
          </p>
          <a href="/support/contact" className="text-primary text-xs font-bold uppercase tracking-widest hover:text-primary/80 transition-colors inline-flex items-center gap-1.5">
            Get in Touch <ArrowRight size={12} />
          </a>
        </div>
      </div>
    </div>
  );
}

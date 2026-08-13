import PageHeader from "../../components/PageHeader";

const TEAM = [
  {
    name: "Marcus Holt",
    role: "Co-founder & Lead Structural Designer",
    specialty: "Architecture · Large-scale builds",
    bio: "Structural engineer by training, AFOL by compulsion. Marcus designed the load-bearing viaduct in Mountain Railway Express and holds the studio record for most rebuild iterations on a single set (fourteen, Dragon Fortress).",
    sets: ["Millennium City Skyline", "Mountain Railway Express", "Dragon Fortress"],
    image: "https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=400&h=400&fit=crop&auto=format",
    years: 12,
  },
  {
    name: "Priya Nair",
    role: "Co-founder & Art Director",
    specialty: "Color systems · Stud art · Art Series",
    bio: "Graphic designer turned brick artist. Priya leads all color palette decisions, designed the 312-tile stud-art screen on the Game Boy Collector's Edition, and heads our ongoing Art Series collaborations.",
    sets: ["Retro Game Boy — Collector's Edition", "Geometric Color Study No. 7", "Enchanted Forest Temple"],
    image: "https://images.unsplash.com/photo-1631106254201-ffbee2305c5b?w=400&h=400&fit=crop&auto=format",
    years: 8,
  },
  {
    name: "James Calloway",
    role: "Co-founder & Product Lead",
    specialty: "Mechanism design · Technic integration",
    bio: "Former toy industry product manager with 15 years of manufacturing experience. James handles production feasibility, piece sourcing, and the mechanical systems — portcullises, pistons, articulated arms.",
    sets: ["Deep Sea Explorer Sub", "Dragon Fortress", "Retro Space Station"],
    image: "https://images.unsplash.com/photo-1620309668391-26ac1c90f61b?w=400&h=400&fit=crop&auto=format",
    years: 15,
  },
  {
    name: "Sofia Brennan",
    role: "Senior Build Designer",
    specialty: "Fantasy · Nature · Organic forms",
    bio: "Joined Alpine Brick in 2023 after winning back-to-back titles at BrickFair Virginia. Sofia specializes in organic shapes and living-world aesthetics — the moss-brick vine system and ancient tree in Enchanted Forest Temple are entirely hers.",
    sets: ["Enchanted Forest Temple", "Mountain Railway Express"],
    image: "https://images.unsplash.com/photo-1633469924738-52101af51d87?w=400&h=400&fit=crop&auto=format",
    years: 6,
  },
  {
    name: "Daniel Osei",
    role: "Build Designer",
    specialty: "Space · Sci-fi · Modular systems",
    bio: "Astrophysics student who found bricks more satisfying than theory. Daniel designed the modular port system in Retro Space Station and is currently deep in R&D on the next Space collection entry.",
    sets: ["Retro Space Station"],
    image: "https://images.unsplash.com/photo-1644175897056-50f4d3a9a827?w=400&h=400&fit=crop&auto=format",
    years: 3,
  },
  {
    name: "Yuki Tanaka",
    role: "Quality & Instruction Designer",
    specialty: "Builder guides · QA · Piece verification",
    bio: "Former technical writer who became obsessed with the craft of LEGO instruction design. Every illustrated builder's guide is Yuki's work — including the 420-page Dragon Fortress epic that multiple builders have described as 'a pleasure to read.'",
    sets: ["All Sets"],
    image: "https://images.unsplash.com/photo-1631106256072-54c89defe828?w=400&h=400&fit=crop&auto=format",
    years: 4,
  },
];

export default function Designers() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        crumbs={[{ label: "Home", to: "/" }, { label: "Our Designers" }]}
        eyebrow="The Team"
        title="Our Designers"
        subtitle="Six builders. Every set you see is the result of their combined obsession with getting it right."
        image="https://images.unsplash.com/photo-1765403256661-c60b291c38ba?w=1600&h=500&fit=crop&auto=format"
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {TEAM.map((member) => (
            <div key={member.name} className="border border-border hover:border-primary/35 transition-all duration-300 group overflow-hidden">
              <div className="relative h-52 overflow-hidden bg-muted">
                <img
                  src={member.image}
                  alt={member.name}
                  className="w-full h-full object-cover opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />
                <div className="absolute bottom-4 left-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground bg-background/70 backdrop-blur-sm px-2.5 py-1 border border-border">
                    {member.years} yrs experience
                  </span>
                </div>
              </div>
              <div className="p-6">
                <div className="text-primary text-[10px] font-bold uppercase tracking-widest mb-1">{member.specialty}</div>
                <h3
                  className="text-xl font-black uppercase leading-tight mb-0.5"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {member.name}
                </h3>
                <div className="text-muted-foreground text-xs mb-4">{member.role}</div>
                <p className="text-muted-foreground text-xs leading-relaxed mb-4">{member.bio}</p>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Sets Designed</div>
                  <div className="flex flex-wrap gap-1.5">
                    {member.sets.map((s) => (
                      <span key={s} className="text-[10px] bg-secondary border border-border px-2 py-0.5 text-muted-foreground">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-16 border border-border p-10 text-center">
          <h3 className="text-3xl font-black uppercase mb-4" style={{ fontFamily: "var(--font-display)" }}>
            Want to Join the Team?
          </h3>
          <p className="text-muted-foreground text-sm mb-6 max-w-lg mx-auto leading-relaxed">
            We're a small, serious studio. When we grow, we grow carefully. Check our Careers page for current openings, or introduce yourself through the Community forum.
          </p>
          <a
            href="/careers"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors"
          >
            View Openings
          </a>
        </div>
      </div>
    </div>
  );
}

export interface Product {
  id: number;
  name: string;
  category: string;
  pieces: number;
  price: number;
  badge: string | null;
  images: string[];
  description: string;
  longDescription: string;
  features: string[];
  includes: string[];
  difficulty: "Beginner" | "Intermediate" | "Advanced" | "Expert";
  ageRecommendation: string;
  dimensions: string;
  setNumber: string;
  builderNotes: string;
  rating: number;
  reviewCount: number;
}

const BASE = "https://images.unsplash.com/photo-";

export const PRODUCTS: Product[] = [
  {
    id: 1,
    name: "Millennium City Skyline",
    category: "Architecture",
    pieces: 2847,
    price: 189,
    badge: "Best Seller",
    images: [
      `${BASE}1774223638287-021fed6e3b3d?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1760883786219-166f9a0398f1?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1587654780291-39c9404d746b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1631106254201-ffbee2305c5b?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "A sprawling metropolis skyline featuring iconic towers, suspension bridges, and hidden details throughout every city block.",
    longDescription:
      "The Millennium City Skyline is our most ambitious architectural build to date. Meticulously designed over eight months by our AFOL team, this set captures the energy of a thriving modern city in extraordinary brick detail. From the interlocking street-level shops to the penthouse rooftop gardens crowning the tallest tower, every layer rewards closer inspection. The suspension bridge connecting the two main districts is fully poseable, and the waterfront district includes a working drawbridge mechanism hidden beneath the promenade.",
    features: [
      "Fully detailed street-level shopfronts with opening doors",
      "Poseable suspension bridge with working cable tension mechanism",
      "Hidden drawbridge mechanism in the waterfront district",
      "Rooftop gardens with micro-scale trees and benches",
      "Modular base design — expand the skyline with future sets",
      "Display stand and city map tile included",
    ],
    includes: [
      "6 exclusive minifigures (Mayor, Architect, Street vendor, Tourist ×2, Police officer)",
      "Display nameplate",
      "Illustrated builder's guide (280 pages)",
      "City district map art print",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Expert",
    ageRecommendation: "16+",
    dimensions: "68 × 32 × 48 cm (assembled)",
    setNumber: "ABE-1001",
    builderNotes:
      "We struggled with the bridge suspension cables for weeks before landing on a SNOT technique that holds tension without any non-standard parts. The waterfront drawbridge was a late addition — once we got it working, we had to redesign the entire promenade around it. Worth every rebuild.",
    rating: 4.9,
    reviewCount: 214,
  },
  {
    id: 2,
    name: "Deep Sea Explorer Sub",
    category: "Ocean",
    pieces: 1204,
    price: 94,
    badge: "New",
    images: [
      `${BASE}1631106254201-ffbee2305c5b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1620309668391-26ac1c90f61b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1633469924738-52101af51d87?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1644175897056-50f4d3a9a827?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "Dive into the abyss with a fully-detailed research submarine, underwater station, and articulated mechanical arm.",
    longDescription:
      "The Deep Sea Explorer Sub began as a sketch on a napkin at a LEGO Fan convention and grew into one of our most technically impressive builds. The submarine hull uses a continuous SNOT curve across 140 bricks to achieve its hydrodynamic silhouette — no flat panels in sight. The accompanying research station clips onto the sub at three docking points and extends into a modular seafloor base with coral formations, a treasure wreck section, and a glowing crystal cave built entirely from transparent bricks.",
    features: [
      "Continuous curved hull — no flat panel sections",
      "Articulated 3-axis mechanical arm with claw",
      "Detachable research station with 3 docking clamps",
      "Transparent brick crystal cave section",
      "Coral reef micro-landscape with printed sea floor tiles",
      "Interior crew cabin with instrument panel details",
    ],
    includes: [
      "4 minifigures (Research pilot, Marine biologist, Engineer, Deep sea diver)",
      "Diving equipment accessories pack",
      "Illustrated builder's guide (180 pages)",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Intermediate",
    ageRecommendation: "12+",
    dimensions: "54 × 18 × 24 cm (assembled)",
    setNumber: "ABE-2001",
    builderNotes:
      "The curved hull took three prototypes to get right. We went through about 400 test bricks figuring out the SNOT offset angles before the seams disappeared. The crystal cave was added in week twelve when we realized the seafloor base needed something that would photograph brilliantly under a desk lamp.",
    rating: 4.8,
    reviewCount: 97,
  },
  {
    id: 3,
    name: "Dragon Fortress",
    category: "Fantasy",
    pieces: 3156,
    price: 249,
    badge: "Limited",
    images: [
      `${BASE}1633469924738-52101af51d87?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1644175897056-50f4d3a9a827?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1631106256072-54c89defe828?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1587654780291-39c9404d746b?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "Ancient stone walls, a fire-breathing dragon minifig, and seven secret passages hidden inside this epic castle build.",
    longDescription:
      "Dragon Fortress is our flagship fantasy build — three years of concept sketches distilled into 3,156 bricks of battlements, towers, and secrets. The fortress is split across two levels: a lower courtyard with stables, a forge, and a dungeon, and an upper keep with the throne room, a great hall, and the dragon's lair. Every wall section hinges open to reveal the interior, and the seven secret passages are genuinely hidden — even our test builders took an average of four hours to find them all. Only 1,000 sets will ever be produced.",
    features: [
      "Seven genuinely hidden secret passages throughout the fortress",
      "Full hinged wall sections for interior access",
      "Working portcullis with chain-and-gear mechanism",
      "Dragon's lair with lava floor built from transparent orange bricks",
      "Forge with printed anvil tile and working bellows detail",
      "Dungeon with removable prison bars and treasure chest",
    ],
    includes: [
      "10 minifigures (Dragon knight, Queen, Wizard, Blacksmith, Guard ×4, Prisoner, Dragon rider)",
      "Exclusive flame-wing dragon figure (custom mold)",
      "Illustrated builder's guide (420 pages)",
      "Fortress lore booklet",
      "Numbered limited-edition certificate (of 1,000)",
    ],
    difficulty: "Expert",
    ageRecommendation: "18+",
    dimensions: "72 × 56 × 62 cm (assembled)",
    setNumber: "ABE-3001-LE",
    builderNotes:
      "The secret passages were designed last — we built the entire fortress first, then went back and carved the passages through it without disturbing the exterior. Two of them required us to redesign structural columns from scratch. The portcullis mechanism took six iterations; the seventh version uses a worm gear borrowed from a Technic concept we abandoned three years ago.",
    rating: 5.0,
    reviewCount: 63,
  },
  {
    id: 4,
    name: "Retro Space Station",
    category: "Space",
    pieces: 987,
    price: 79,
    badge: null,
    images: [
      `${BASE}1620309668391-26ac1c90f61b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1631106256072-54c89defe828?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1587654780291-39c9404d746b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1633469924738-52101af51d87?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "Inspired by the golden age of space exploration — vintage-styled habitat modules, solar arrays, and a docking crew of four.",
    longDescription:
      "The Retro Space Station is a love letter to the optimistic space programs of the 1960s and 70s, filtered through AFOL eyes. Every module is designed to be reconfigured — the habitat ring, science lab, communications array, and docking collar all connect via a standardized port system, so builders can design their own station layout before committing to the display configuration. The color palette uses authentic period shades: a warm off-white, retro orange, and classic space blue that you won't find in any current official set.",
    features: [
      "Fully modular — six modules reconfigure into 12+ layouts",
      "Standardized port connection system across all modules",
      "Rotating solar array panels (360° on two axes)",
      "Period-authentic color palette exclusive to this set",
      "Printed instrument panels on every module interior",
      "Display stand with constellation star map base tile",
    ],
    includes: [
      "4 minifigures (Commander, Scientist, Engineer, Cosmonaut) with retro-styled suits",
      "Illustrated builder's guide (148 pages)",
      "Module reconfiguration guide",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Beginner",
    ageRecommendation: "10+",
    dimensions: "42 × 42 × 28 cm (assembled, standard layout)",
    setNumber: "ABE-4001",
    builderNotes:
      "The port system was the key design decision that made this set. Once we committed to it, everything else followed naturally. We spent two months just on the color palette, ordering custom dye samples until the orange matched a photo of an Apollo-era spacesuit glove we had pinned above the design desk.",
    rating: 4.7,
    reviewCount: 142,
  },
  {
    id: 5,
    name: "Mountain Railway Express",
    category: "Nature",
    pieces: 1567,
    price: 134,
    badge: "New",
    images: [
      `${BASE}1644175897056-50f4d3a9a827?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1774223638287-021fed6e3b3d?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1620309668391-26ac1c90f61b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1631106254201-ffbee2305c5b?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "Wind through alpine meadows and granite cliffs aboard this painstakingly detailed steam locomotive and stone viaduct.",
    longDescription:
      "The Mountain Railway Express captures a specific feeling: the smell of coal smoke as a narrow-gauge locomotive rounds a granite cliff face, the valley opening below, the viaduct arching across the gorge like something from another century. The locomotive features a working piston mechanism driven by the rear wheels, and the tender car opens to reveal a detailed coal loading area. The viaduct spans 58 cm and is fully load-bearing — engineered to support the locomotive with a 2 kg margin above the brick weight.",
    features: [
      "Working piston mechanism on the locomotive (driven by wheel rotation)",
      "Opening tender with detailed coal loading area",
      "Load-bearing viaduct spanning 58 cm (engineered for structural integrity)",
      "Layered granite cliff face using 14 different gray brick variants",
      "Alpine meadow base with wildflower details and grazing sheep",
      "Station building with operating signal light mechanism",
    ],
    includes: [
      "5 minifigures (Engineer, Fireman, Station master, Passenger ×2)",
      "Steam locomotive and two passenger cars",
      "Illustrated builder's guide (220 pages)",
      "Structural load certificate",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Advanced",
    ageRecommendation: "14+",
    dimensions: "88 × 24 × 36 cm (assembled)",
    setNumber: "ABE-5001",
    builderNotes:
      "The viaduct was stress-tested at 8 kg before we approved it. We wanted builders to know they could actually run the locomotive across it without fear. The 14 gray variants in the cliff face caused real supply headaches — three of them had to be sourced from aftermarket suppliers — but the texture result justified every email.",
    rating: 4.9,
    reviewCount: 88,
  },
  {
    id: 6,
    name: "Enchanted Forest Temple",
    category: "Fantasy",
    pieces: 2103,
    price: 167,
    badge: null,
    images: [
      `${BASE}1631106256072-54c89defe828?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1633469924738-52101af51d87?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1644175897056-50f4d3a9a827?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1765403256661-c60b291c38ba?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "Moss-covered ruins, glowing crystal minifigs, and ancient woodland spirits guard the sacred temple sanctum.",
    longDescription:
      "The Enchanted Forest Temple is built around a single design principle: everything is alive. The ruins are overgrown with moss-brick vines, the roots of a 40-cm ancient tree are lifting flagstones from the courtyard floor, and the crystal spirits that inhabit the inner sanctum are built from a combination of transparent and translucent bricks that create genuine depth when backlit. The temple splits into four quadrant sections for interior access, and each quadrant tells a different chapter of the forest lore told in the accompanying booklet.",
    features: [
      "Four quadrant sections split for interior access",
      "40 cm ancient tree with root system lifting courtyard flagstones",
      "Layered transparent/translucent crystal spirits (backlit-ready)",
      "Moss-brick vine system covering 30% of all exterior surfaces",
      "Hidden altar chamber beneath the temple floor",
      "Seasonal swap kit — summer and autumn foliage variants included",
    ],
    includes: [
      "7 minifigures (Forest guardian, Crystal spirit ×3, Druid, Adventurer, Woodland sprite)",
      "Seasonal foliage swap pack (summer/autumn)",
      "Temple lore booklet",
      "Illustrated builder's guide (310 pages)",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Advanced",
    ageRecommendation: "14+",
    dimensions: "58 × 58 × 52 cm (assembled)",
    setNumber: "ABE-6001",
    builderNotes:
      "The seasonal swap kit was a last-minute addition after a builder in our test group mentioned they wanted to change the display for autumn. We went back into production to add it. The translucent crystal spirits work best with a white LED light strip placed behind the inner sanctum wall — the effect when you do that is genuinely something we're proud of.",
    rating: 4.8,
    reviewCount: 119,
  },
];

export const SPOTLIGHTS: Product[] = [
  {
    id: 101,
    name: "Retro Game Boy — Collector's Edition",
    category: "Limited Edition",
    pieces: 1024,
    price: 219,
    badge: "One of a Kind",
    images: [
      `${BASE}1764557257729-78a549bf2929?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1765403256661-c60b291c38ba?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1620309668391-26ac1c90f61b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1587654780291-39c9404d746b?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "A museum-quality brick replica of the iconic handheld console. Pixel-perfect stud-art screen, working cartridge slot detail, and numbered certificate of authenticity. Only 500 made.",
    longDescription:
      "The Retro Game Boy Collector's Edition is the most technically demanding set we've ever produced. The stud-art screen renders a pixel-perfect scene using 312 individual 1×1 tiles in 11 colors — each tile placed by hand during final quality control. The cartridge slot is fully functional: the included game cartridge brick slides in with the same resistance as the original hardware. The build uses a proprietary internal frame system that keeps the iconic silhouette mathematically accurate to within 2mm of the original device's proportions.",
    features: [
      "312-tile stud-art screen, pixel-perfect in 11 colors",
      "Functional cartridge slot — included game cartridge slides in/out",
      "Mathematically accurate silhouette (within 2mm of original dimensions)",
      "Proprietary internal frame system for structural integrity",
      "Display easel built into the design",
      "Only 500 units worldwide — hand-inspected before shipment",
    ],
    includes: [
      "1 Collector's Edition set",
      "1 game cartridge brick (Tetris label, printed)",
      "Certificate of authenticity (hand-signed, numbered of 500)",
      "Collector's box with magnetic closure",
      "Illustrated builder's guide (160 pages)",
      "White-glove delivery packaging",
    ],
    difficulty: "Advanced",
    ageRecommendation: "16+",
    dimensions: "28 × 18 × 6 cm (assembled)",
    setNumber: "ABE-LE-101",
    builderNotes:
      "We measured a real Game Boy fourteen times before we were satisfied the silhouette was correct. The cartridge slot is the feature we're most proud of — it required designing a custom brick geometry that we then had to verify wouldn't violate any IP. The stud-art screen took three artists three weeks to agree on. Number 001 of 500 is on our studio display shelf.",
    rating: 5.0,
    reviewCount: 47,
  },
  {
    id: 102,
    name: "Geometric Color Study No. 7",
    category: "Art Series",
    pieces: 4892,
    price: 389,
    badge: "Designer Series",
    images: [
      `${BASE}1765403256661-c60b291c38ba?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1587654780291-39c9404d746b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1631106254201-ffbee2305c5b?w=900&h=720&fit=crop&auto=format`,
      `${BASE}1633469924738-52101af51d87?w=900&h=720&fit=crop&auto=format`,
    ],
    description:
      "A collaboration with abstract artists — a 94×94 cm wall-mounted statement piece that is equally art object and building challenge.",
    longDescription:
      "Color Study No. 7 is the seventh in our ongoing Art Series — a collaboration between our AFOL design team and abstract painters working in the Pacific Northwest. The design originates as a 94×94 cm oil painting, which our team then translates into brick, negotiating between the infinite gradients of paint and the discrete world of the 1×1 tile. The result is not a copy of the painting but a conversation with it — some areas are faithful translations, others are deliberate brick-specific interpretations where the stud grid creates patterns paint cannot. Includes two wall-mount systems: a flush plate for framed display and a 15° angled bracket for gallery-style propped presentation.",
    features: [
      "94×94 cm completed dimensions — genuine statement scale",
      "4,892 bricks across 31 distinct colors",
      "Two wall-mount systems (flush plate + 15° angled gallery bracket)",
      "Collaborative design with named Pacific Northwest abstract artists",
      "Build sequence designed to reveal the composition gradually",
      "Museum-quality display — suitable for professional gallery installation",
    ],
    includes: [
      "Complete brick kit (sorted by build sequence, not color)",
      "Certificate of artistic collaboration (signed by both design teams)",
      "Flush wall mount plate and hardware",
      "15° angled gallery bracket",
      "Archival illustrated builder's guide (380 pages)",
      "Artist statement booklet",
      "Numbered certificate of authenticity",
    ],
    difficulty: "Expert",
    ageRecommendation: "18+",
    dimensions: "94 × 94 × 4 cm (assembled)",
    setNumber: "ABE-ART-007",
    builderNotes:
      "We sort the bricks by build sequence rather than color intentionally — you discover the composition as you build it, the same way the artist discovered it while painting. Sorting by color first and building section-by-section destroys that experience. Trust the sequence. The reveal in the final 800 bricks is worth it.",
    rating: 4.9,
    reviewCount: 31,
  },
];

export const ALL_PRODUCTS = [...PRODUCTS, ...SPOTLIGHTS];

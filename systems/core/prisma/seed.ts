import { prisma } from '../src/prisma.js'

// Development fixture data. This is NOT the real catalogue and must never be
// presented as such. Images are neutral placeholders — real product
// photography is the largest open gap in the storefront build.
//
// homePosition and collectionPosition are deliberately DIFFERENT sequences:
// a product's place on the home page is not its place inside a collection,
// and a seed that set them identically would make the second column look like
// dead weight.
const PRODUCTS = [
  {
    slug: 'millennium-city-skyline',
    name: 'Millennium City Skyline',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['architecture'],
    imagesJson: [
      { url: '/img/placeholder/skyline-1.svg', alt: 'Placeholder image for Millennium City Skyline' },
      { url: '/img/placeholder/skyline-2.svg', alt: 'Placeholder alternate view of Millennium City Skyline' },
    ],
    description: 'A sprawling metropolis skyline with towers, bridges and hidden details.',
    longDescription:
      'A large architectural build capturing a modern city in brick detail, from street-level shopfronts to rooftop gardens crowning the tallest tower.',
    pieces: 2847,
    difficulty: 'expert' as const,
    ageRecommendation: '16+',
    dimensions: '68 x 32 x 48 cm (assembled)',
    features: [
      'Detailed street-level shopfronts with opening doors',
      'Poseable suspension bridge',
      'Modular base design so the skyline can be extended',
    ],
    includes: ['Display nameplate', 'Illustrated builder guide', 'City district map print'],
    builderNotes:
      'The bridge suspension took several prototypes before the tension held without non-standard parts.',
    homePosition: 1,
    collectionPosition: 4,
    variants: [{ sku: 'ABE-1001', priceCents: 18900, onHand: 12 }],
  },
  {
    slug: 'deep-sea-explorer-sub',
    name: 'Deep Sea Explorer Sub',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['ocean'],
    imagesJson: [
      { url: '/img/placeholder/sub-1.svg', alt: 'Placeholder image for Deep Sea Explorer Sub' },
    ],
    description: 'A research submarine with an underwater station and articulated arm.',
    longDescription:
      'A continuous curved hull built without flat panel sections, docking with a modular seafloor station.',
    pieces: 1204,
    difficulty: 'intermediate' as const,
    ageRecommendation: '12+',
    dimensions: '54 x 18 x 24 cm (assembled)',
    features: [
      'Continuous curved hull with no flat panel sections',
      'Articulated three-axis mechanical arm',
      'Detachable research station with docking clamps',
    ],
    includes: ['Diving equipment accessory pack', 'Illustrated builder guide'],
    builderNotes: 'The curved hull took three prototypes before the seams disappeared.',
    homePosition: 2,
    collectionPosition: 7,
    variants: [{ sku: 'ABE-2001', priceCents: 9400, onHand: 20 }],
  },
  {
    slug: 'dragon-fortress',
    name: 'Dragon Fortress',
    productType: 'own_designed' as const,
    releaseType: 'limited_run' as const,
    status: 'published' as const,
    categories: ['fantasy', 'limited-edition'],
    imagesJson: [
      { url: '/img/placeholder/fortress-1.svg', alt: 'Placeholder image for Dragon Fortress' },
      { url: '/img/placeholder/fortress-2.svg', alt: 'Placeholder alternate view of Dragon Fortress' },
    ],
    description: 'Ancient stone walls, a fire-breathing dragon and seven secret passages.',
    longDescription:
      'A castle build with layered stonework, hidden chambers and a hinged gatehouse that opens the whole interior.',
    pieces: 3156,
    difficulty: 'expert' as const,
    ageRecommendation: '16+',
    dimensions: '46 x 40 x 38 cm (assembled)',
    features: [
      'Seven concealed passages through the walls',
      'Hinged gatehouse opening the full interior',
      'Poseable dragon with articulated wings',
    ],
    includes: ['Display nameplate', 'Illustrated builder guide', 'Numbered certificate'],
    builderNotes: 'The gatehouse hinge was rebuilt twice before it held the weight of the towers.',
    homePosition: 3,
    collectionPosition: 1,
    variants: [{ sku: 'ABE-3001', priceCents: 24900, onHand: 5 }],
  },
  {
    slug: 'orbital-research-station',
    name: 'Orbital Research Station',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['space'],
    imagesJson: [
      { url: '/img/placeholder/station-1.svg', alt: 'Placeholder image for Orbital Research Station' },
    ],
    description: 'A modular orbital station with rotating habitat ring and docking ports.',
    longDescription:
      'Six connectable modules around a central spine, with a habitat ring that rotates freely on a hidden turntable.',
    pieces: 1890,
    difficulty: 'advanced' as const,
    ageRecommendation: '14+',
    dimensions: '42 x 42 x 30 cm (assembled)',
    features: [
      'Rotating habitat ring on a concealed turntable',
      'Six interchangeable modules',
      'Two docking ports sized for the shuttle set',
    ],
    includes: ['Display stand', 'Illustrated builder guide'],
    builderNotes: 'Getting the ring to rotate without wobble meant hiding the turntable inside the spine.',
    homePosition: 4,
    collectionPosition: 8,
    variants: [{ sku: 'ABE-4001', priceCents: 13900, onHand: 15 }],
  },
  {
    slug: 'botanical-conservatory',
    name: 'Botanical Conservatory',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['nature', 'architecture'],
    imagesJson: [
      { url: '/img/placeholder/conservatory-1.svg', alt: 'Placeholder image for Botanical Conservatory' },
    ],
    description: 'A glasshouse of transparent panels filled with brick-built botanicals.',
    longDescription:
      'An arched glasshouse whose transparent panelling encloses a planted interior of custom botanical builds.',
    pieces: 2140,
    difficulty: 'advanced' as const,
    ageRecommendation: '14+',
    dimensions: '38 x 30 x 28 cm (assembled)',
    features: [
      'Arched transparent panelling',
      'Twelve distinct brick-built plant species',
      'Removable roof for interior access',
    ],
    includes: ['Illustrated builder guide', 'Botanical name plaques'],
    builderNotes: 'The arch was the hard part — the curve is built from straight panels at graduating angles.',
    homePosition: 5,
    collectionPosition: 2,
    variants: [{ sku: 'ABE-5001', priceCents: 15900, onHand: 18 }],
  },
  {
    slug: 'coral-reef-diorama',
    name: 'Coral Reef Diorama',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['ocean', 'nature'],
    imagesJson: [
      { url: '/img/placeholder/reef-1.svg', alt: 'Placeholder image for Coral Reef Diorama' },
    ],
    description: 'A layered reef scene in translucent and textured brick.',
    longDescription:
      'A shallow reef built in three depth layers, using translucent bricks to suggest water above a textured seabed.',
    pieces: 980,
    difficulty: 'beginner' as const,
    ageRecommendation: '10+',
    dimensions: '32 x 24 x 18 cm (assembled)',
    features: [
      'Three-layer depth construction',
      'Translucent brick water surface',
      'Nine reef species in brick',
    ],
    includes: ['Illustrated builder guide'],
    builderNotes: 'Kept deliberately approachable — this is the set we hand to a first-time builder.',
    homePosition: 6,
    collectionPosition: 5,
    variants: [{ sku: 'ABE-6001', priceCents: 6900, onHand: 30 }],
  },
  {
    slug: 'lunar-lander-replica',
    name: 'Lunar Lander Replica',
    productType: 'resale' as const,
    releaseType: 'limited_run' as const,
    status: 'published' as const,
    categories: ['space', 'limited-edition'],
    imagesJson: [
      { url: '/img/placeholder/lander-1.svg', alt: 'Placeholder image for Lunar Lander Replica' },
    ],
    description: 'A previously-sold lander set, complete and ready to display.',
    longDescription:
      'A collectible previously-retail set acquired complete, with foil-detailed panels and a display base.',
    pieces: 1087,
    difficulty: 'intermediate' as const,
    ageRecommendation: '12+',
    dimensions: '28 x 28 x 26 cm (assembled)',
    features: [
      'Foil-detailed descent stage panels',
      'Poseable landing legs',
      'Display base with printed plaque',
    ],
    includes: ['Original display base', 'Illustrated builder guide'],
    builderNotes: 'Sourced complete. Verified piece-by-piece against the original inventory before listing.',
    homePosition: 7,
    collectionPosition: 3,
    variants: [{ sku: 'ABE-7001', priceCents: 21900, onHand: 3 }],
  },
  {
    slug: 'clocktower-square',
    name: 'Clocktower Square',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['architecture'],
    imagesJson: [
      { url: '/img/placeholder/clocktower-1.svg', alt: 'Placeholder image for Clocktower Square' },
    ],
    description: 'A town square anchored by a working geared clocktower.',
    longDescription:
      'A modular town square whose clocktower carries a geared mechanism driving both hands from a single dial.',
    pieces: 1650,
    difficulty: 'advanced' as const,
    ageRecommendation: '14+',
    dimensions: '36 x 36 x 44 cm (assembled)',
    features: [
      'Geared clock mechanism driving both hands',
      'Modular paving that connects to other square sets',
      'Four detailed shopfronts',
    ],
    includes: ['Illustrated builder guide', 'Spare gear set'],
    builderNotes: 'The gear ratio took longer to solve than the entire rest of the build.',
    homePosition: 8,
    collectionPosition: 6,
    variants: [{ sku: 'ABE-8001', priceCents: 11900, onHand: 22 }],
  },

  // ---------------------------------------------------------------------
  // LOAD-BEARING TEST FIXTURES — do not rename, reprice, or restock.
  //
  // tests/orders-service.test.ts, orders-api, orders-schema, orders-concurrency
  // and orders-transitions all resolve variants by these exact SKUs and assert
  // against these exact prices and stock levels:
  //   BBS-STD  priceCents 4999, onHand 25
  //   CMP-LTD  onHand 8
  // Changing them breaks five test files that have nothing to do with the
  // catalogue. Add new products above instead.
  // ---------------------------------------------------------------------
  {
    slug: 'brick-builder-set',
    name: 'Brick Builder Set',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['starter'],
    imagesJson: [
      { url: '/img/placeholder/starter-1.svg', alt: 'Placeholder image for Brick Builder Set' },
    ],
    description: 'An entry-level build used as a development fixture.',
    longDescription: '',
    pieces: 320,
    difficulty: 'beginner' as const,
    ageRecommendation: '8+',
    dimensions: '18 x 14 x 10 cm (assembled)',
    features: [],
    includes: [],
    builderNotes: '',
    homePosition: 9,
    collectionPosition: 10,
    variants: [{ sku: 'BBS-STD', priceCents: 4999, onHand: 25 }],
  },
  {
    slug: 'castle-mega-pack',
    name: 'Castle Mega Pack (Limited)',
    productType: 'resale' as const,
    releaseType: 'limited_run' as const,
    status: 'published' as const,
    categories: ['fantasy', 'limited-edition'],
    imagesJson: [
      { url: '/img/placeholder/castle-1.svg', alt: 'Placeholder image for Castle Mega Pack' },
    ],
    description: 'A previously-sold castle set used as a development fixture.',
    longDescription: '',
    pieces: 1420,
    difficulty: 'intermediate' as const,
    ageRecommendation: '12+',
    dimensions: '34 x 28 x 30 cm (assembled)',
    features: [],
    includes: [],
    builderNotes: '',
    homePosition: 10,
    collectionPosition: 9,
    variants: [{ sku: 'CMP-LTD', priceCents: 12999, onHand: 8 }],
  },
]

export async function seed(): Promise<void> {
  await prisma.actor.upsert({
    where: { id: 'system' }, update: {},
    create: { id: 'system', type: 'human', name: 'system' },
  })
  for (const p of PRODUCTS) {
    const { variants, ...fields } = p
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        ...fields,
        variants: {
          create: variants.map(v => ({
            sku: v.sku, priceCents: v.priceCents,
            inventory: { create: { onHand: v.onHand } },
          })),
        },
      },
    })
  }
}

// Allow `npm run seed` to execute it directly.
if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then(() => prisma.$disconnect())
}

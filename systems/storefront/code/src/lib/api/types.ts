export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export interface ProductImage {
  /** Immutable storage key, NOT a URL. Resolve it with lib/images.ts. */
  storageKey: string;
  alt: string;
  /** Intrinsic pixel size. Render these so cards reserve layout space. */
  width: number;
  height: number;
  /** Display order within the product; 0 is the primary image. */
  position: number;
}

export interface Variant {
  id: string;
  sku: string;
  priceCents: number;
  currency: string;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  productType: 'own_designed' | 'resale';
  releaseType: 'standard' | 'limited_run' | 'specialty';
  status: string;
  images: ProductImage[];
  categories: string[];
  pieces: number | null;
  difficulty: Difficulty | null;
  ageRecommendation: string | null;
  dimensions: string | null;
  longDescription: string;
  features: string[];
  includes: string[];
  builderNotes: string;
  homePosition: number | null;
  collectionPosition: number | null;
  createdAt: string;
  variants: Variant[];
}

export interface ProductListPage {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Availability {
  variantId: string;
  sku: string;
  available: number;
}

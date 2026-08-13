export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export interface ProductImage {
  url: string;
  alt: string;
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

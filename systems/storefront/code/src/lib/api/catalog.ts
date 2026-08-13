import { apiFetch } from './client';
import type { Product, ProductListPage, Availability } from './types';

const BASE = '/api/v1/catalog';

export type CatalogSort =
  | 'name_asc'
  | 'price_asc'
  | 'price_desc'
  | 'newest'
  | 'home_display'
  | 'collection_display';

export interface GetProductsOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  sort?: CatalogSort;
}

type ProductListBody = Omit<ProductListPage, 'totalPages'>;

function computeTotalPages(total: number, pageSize: number): number {
  if (pageSize === 0) return 0;
  return Math.ceil(total / pageSize);
}

export async function getProducts(opts: GetProductsOptions = {}): Promise<ProductListPage> {
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
  if (opts.search !== undefined) params.set('search', opts.search);
  if (opts.category !== undefined) params.set('category', opts.category);
  if (opts.sort !== undefined) params.set('sort', opts.sort);

  const qs = params.toString();
  const url = qs ? `${BASE}/products?${qs}` : `${BASE}/products`;

  const body = await apiFetch<ProductListBody>(url);
  return { ...body, totalPages: computeTotalPages(body.total, body.pageSize) };
}

export function getProduct(idOrSlug: string): Promise<Product> {
  return apiFetch<Product>(`${BASE}/products/${encodeURIComponent(idOrSlug)}`);
}

export function getAvailability(idOrSlug: string): Promise<Availability[]> {
  return apiFetch<Availability[]>(
    `${BASE}/products/${encodeURIComponent(idOrSlug)}/availability`,
  );
}

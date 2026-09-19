import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getProducts } from './catalog';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockPage(body: unknown): { fetchMock: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  return { fetchMock, calls };
}

describe('getProducts', () => {
  it('sends only supplied params — category and sort present, search absent', async () => {
    const { fetchMock, calls } = mockPage({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.stubGlobal('fetch', fetchMock);
    await getProducts({ category: 'technic', sort: 'name_asc' });
    const url = calls[0];
    expect(url).toContain('category=technic');
    expect(url).toContain('sort=name_asc');
    expect(url).not.toContain('search=');
  });

  it('derives totalPages from total and pageSize (45 / 20 -> 3)', async () => {
    const { fetchMock } = mockPage({ items: [], total: 45, page: 1, pageSize: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getProducts({ page: 1, pageSize: 20 });
    expect(result.totalPages).toBe(3);
  });

  it('returns totalPages 0 when pageSize is 0 rather than dividing by zero', async () => {
    const { fetchMock } = mockPage({ items: [], total: 45, page: 1, pageSize: 0 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getProducts({ page: 1, pageSize: 0 });
    expect(result.totalPages).toBe(0);
  });

  it('sends "pageSize=" and never sends "limit="', async () => {
    const { fetchMock, calls } = mockPage({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.stubGlobal('fetch', fetchMock);
    await getProducts({ page: 1, pageSize: 20 });
    const url = calls[0];
    expect(url).toContain('pageSize=');
    expect(url).not.toContain('limit=');
  });
});

// BASE now resolves against API_BASE_URL (systems/storefront/code/src/lib/apiBase.ts)
// instead of hardcoding a relative path -- on Render a relative path resolves
// against the storefront's own static host and matches the SPA fallback
// rewrite, returning HTML where JSON is expected. import.meta.env is read
// once at module evaluation, so exercising both configurations requires a
// fresh module instance per test: reset the module registry, stub the env
// var, then dynamically import.
describe('BASE resolves against API_BASE_URL', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('empty base is byte-identical to the relative path used today', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { fetchMock, calls } = mockPage({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const { getProducts: getProductsFresh } = await import('./catalog.js');
    await getProductsFresh();
    expect(calls[0]).toBe('/api/v1/catalog/products');
  });

  it('a set base produces a correct absolute URL with exactly one slash', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.alpinebrickexchange.com');
    const { fetchMock, calls } = mockPage({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const { getProducts: getProductsFresh } = await import('./catalog.js');
    await getProductsFresh();
    expect(calls[0]).toBe('https://api.alpinebrickexchange.com/api/v1/catalog/products');
  });

  it('a set base with a trailing slash still produces exactly one slash', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.alpinebrickexchange.com/');
    const { fetchMock, calls } = mockPage({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const { getProducts: getProductsFresh } = await import('./catalog.js');
    await getProductsFresh();
    expect(calls[0]).toBe('https://api.alpinebrickexchange.com/api/v1/catalog/products');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
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

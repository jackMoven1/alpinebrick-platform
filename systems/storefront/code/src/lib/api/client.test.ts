import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiFetch, ApiError } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errResponse(body: unknown, status = 400): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('apiFetch', () => {
  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ hello: 'world' })));
    const result = await apiFetch<{ hello: string }>('/x');
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws ApiError carrying the server code and fields on a 400 envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errResponse({
          code: 'VALIDATION_ERROR',
          message: 'bad request',
          fields: { page: 'must be positive' },
        }),
      ),
    );
    let err: unknown;
    try {
      await apiFetch('/x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('VALIDATION_ERROR');
    expect(apiErr.message).toBe('bad request');
    expect(apiErr.fields).toEqual({ page: 'must be positive' });
  });

  it('synthesises INTERNAL when fetch itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(apiFetch('/x')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/x')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('synthesises INTERNAL when an error body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })),
    );
    await expect(apiFetch('/x')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/x')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

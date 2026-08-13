export type ApiErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL';

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

const KNOWN_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INTERNAL',
]);

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = fields;
  }
}

interface ErrorEnvelope {
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
}

function asEnvelope(body: unknown): ErrorEnvelope | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.code !== 'string' || !KNOWN_CODES.has(b.code as ApiErrorCode)) return null;
  if (typeof b.message !== 'string') return null;
  const fields =
    typeof b.fields === 'object' && b.fields !== null
      ? (b.fields as Record<string, string>)
      : undefined;
  return { code: b.code as ApiErrorCode, message: b.message, fields };
}

export async function apiFetch<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError('INTERNAL', FALLBACK_MESSAGE);
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError('INTERNAL', FALLBACK_MESSAGE);
    }
    const envelope = asEnvelope(body);
    if (envelope) {
      throw new ApiError(
        envelope.code,
        envelope.message || FALLBACK_MESSAGE,
        envelope.fields,
      );
    }
    throw new ApiError('INTERNAL', FALLBACK_MESSAGE);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('INTERNAL', FALLBACK_MESSAGE);
  }
}

// Small fetch wrapper: every call uses a relative path (so the Vite proxy handles it and the cookie
// stays first-party) and every POST carries a JSON body and Content-Type, as the backend requires.
// Error responses are only inspected for their machine code and field names; cookies and signed
// URLs are never read, stored or logged.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
    readonly fields: readonly string[] = [],
  ) {
    super(code === null ? `Request failed with status ${status}` : `Request failed: ${code}`);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: unknown;
  fields?: unknown;
}

async function errorFrom(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A body that is not JSON carries nothing we can use.
  }
  const code = typeof body.error === 'string' ? body.error : null;
  const fields = Array.isArray(body.fields)
    ? body.fields.filter((field): field is string => typeof field === 'string')
    : [];
  return new ApiError(response.status, code, fields);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Small fetch wrapper: every call uses a relative path (so the Vite proxy handles it and the cookie
// stays first-party) and every POST carries a JSON body and Content-Type, as the backend requires.
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new ApiError(response.status);
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

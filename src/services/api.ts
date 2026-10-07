const API_TOKEN_KEY = 'streamvault_auth_token';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`API error: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

function getApiToken(): string {
  try {
    const raw = localStorage.getItem(API_TOKEN_KEY);
    if (!raw) return '';
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      // Older StreamVault releases stored the token without JSON encoding.
      return raw;
    }
  } catch {
    return '';
  }
}

export function hasStoredApiToken(): boolean {
  return getApiToken().length > 0;
}

/** Fetch JSON from StreamVault with the protected-endpoint token in a header. */
// Existing endpoints return heterogeneous JSON; callers may opt into a precise T.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(
  baseUrl: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = getApiToken();
  if (token && !headers.has('x-streamvault-token')) headers.set('x-streamvault-token', token);

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText);
  }

  if (response.status === 204 || response.status === 202) {
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

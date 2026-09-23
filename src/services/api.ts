const API_TOKEN_KEY = 'streamvault_auth_token';

export const BACKEND_UNAVAILABLE_MESSAGE =
  'Cannot reach the StreamVault backend. Check the StreamVault Server URL and make sure the backend is running.';

export class BackendUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(BACKEND_UNAVAILABLE_MESSAGE, options);
    this.name = 'BackendUnavailableError';
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, detail?: string) {
    super(detail || `API error: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class StaleBackendRequestError extends Error {
  constructor() {
    super('Backend changed while the request was in progress');
    this.name = 'StaleBackendRequestError';
  }
}

let backendRequestGeneration = 0;
let backendRequestController = typeof AbortController === 'undefined' ? null : new AbortController();

export function rotateBackendRequestScope(): void {
  backendRequestGeneration++;
  backendRequestController?.abort();
  backendRequestController = typeof AbortController === 'undefined' ? null : new AbortController();
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

export function clearStoredApiToken(): void {
  try {
    localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted runtimes.
  }
}

export function setStoredApiToken(token: string): void {
  try {
    if (token) localStorage.setItem(API_TOKEN_KEY, JSON.stringify(token));
    else localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted runtimes.
  }
}

async function fetchBackend(url: string, options?: RequestInit): Promise<Response> {
  const generation = backendRequestGeneration;
  const signal = options?.signal ?? backendRequestController?.signal;
  try {
    const response = await fetch(url, { ...options, signal });
    if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
    return response;
  } catch (error) {
    if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new BackendUnavailableError({ cause: error });
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === 'string') detail = parsed.error;
        else if (typeof parsed.message === 'string') detail = parsed.message;
      } catch {
        // Keep the stable status fallback for non-JSON error pages.
      }
    }
    throw new ApiError(response.status, response.statusText, detail);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Probe a user-entered backend without forwarding credentials for another origin. */
// The status endpoint is intentionally public and returns heterogeneous status fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function probeBackend<T = any>(baseUrl: string, signal?: AbortSignal): Promise<T> {
  const generation = backendRequestGeneration;
  const response = await fetchBackend(`${baseUrl}/api/status`, { signal, cache: 'no-store' });
  const data = await parseJsonResponse<T>(response);
  if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
  return data;
}

/** Fetch JSON from StreamVault with the protected-endpoint token in a header. */
// Existing endpoints return heterogeneous JSON; callers may opt into a precise T.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(
  baseUrl: string,
  path: string,
  options?: RequestInit,
  tokenOverride?: string | null,
): Promise<T> {
  const generation = backendRequestGeneration;
  const headers = new Headers(options?.headers);
  const token = tokenOverride === undefined ? getApiToken() : tokenOverride || '';
  if (token && !headers.has('x-streamvault-token')) headers.set('x-streamvault-token', token);

  const response = await fetchBackend(`${baseUrl}${path}`, { ...options, headers });
  const data = await parseJsonResponse<T>(response);
  if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
  return data;
}

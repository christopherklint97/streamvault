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
  readonly retryAfter: string | null;

  constructor(status: number, statusText: string, detail?: string, retryAfter: string | null = null) {
    super(detail || `API error: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class StaleBackendRequestError extends Error {
  constructor() {
    super('Backend changed while the request was in progress');
    this.name = 'StaleBackendRequestError';
  }
}

export class ApiTimeoutError extends Error {
  constructor() {
    super('The StreamVault backend took too long to respond. Retry, or check the server connection in Settings.');
    this.name = 'ApiTimeoutError';
  }
}

export type ApiRequestOptions = RequestInit & { timeoutMs?: number };

let backendRequestGeneration = 0;
let backendRequestController = typeof AbortController === 'undefined' ? null : new AbortController();

/** Capture the backend scope for operations spanning several API requests. */
export function getBackendRequestScope(): { generation: number; signal?: AbortSignal } {
  return { generation: backendRequestGeneration, signal: backendRequestController?.signal };
}

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
    throw new ApiError(response.status, response.statusText, detail, response.headers.get('Retry-After'));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Opt-in deadline covers headers and body, even when abort is unsupported. */
async function withRequestDeadline<T>(
  options: ApiRequestOptions | undefined,
  request: (options: RequestInit | undefined) => Promise<T>,
): Promise<T> {
  const { timeoutMs, ...init } = options ?? {};
  if (timeoutMs === undefined) return request(options);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive and finite');
  const generation = backendRequestGeneration;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const cleanups: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const fail = (error: unknown) => {
      reject(generation !== backendRequestGeneration ? new StaleBackendRequestError() : error);
      controller?.abort();
    };
    for (const signal of new Set([init.signal, backendRequestController?.signal])) {
      if (!signal) continue;
      const onAbort = () => fail(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }
    }
    timer = setTimeout(() => fail(new ApiTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([request({ ...init, signal: controller?.signal ?? init.signal }), cancelled]);
  } finally {
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
  }
}

/** Probe a user-entered backend without forwarding credentials for another origin. */
// The status endpoint is intentionally public and returns heterogeneous status fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function probeBackend<T = any>(baseUrl: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  return withRequestDeadline({ signal, cache: 'no-store', timeoutMs }, async init => {
    const generation = backendRequestGeneration;
    const response = await fetchBackend(`${baseUrl}/api/status`, init);
    const data = await parseJsonResponse<T>(response);
    if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
    return data;
  });
}

/** Fetch JSON from StreamVault with the protected-endpoint token in a header. */
// Existing endpoints return heterogeneous JSON; callers may opt into a precise T.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(
  baseUrl: string,
  path: string,
  options?: ApiRequestOptions,
  tokenOverride?: string | null,
): Promise<T> {
  return withRequestDeadline(options, async init => {
    const generation = backendRequestGeneration;
    const headers = new Headers(init?.headers);
    const token = tokenOverride === undefined ? getApiToken() : tokenOverride || '';
    if (token && !headers.has('x-streamvault-token')) headers.set('x-streamvault-token', token);

    const response = await fetchBackend(`${baseUrl}${path}`, { ...init, headers });
    if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
    // Auth rejection is terminal on headers: a stalled body must not hide it
    // behind a caller's timeout or allow a fallback to unauthenticated playback.
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(response.status, response.statusText, undefined, response.headers.get('Retry-After'));
    }
    const data = await parseJsonResponse<T>(response).catch(error => {
      if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
      throw error;
    });
    if (generation !== backendRequestGeneration) throw new StaleBackendRequestError();
    return data;
  });
}

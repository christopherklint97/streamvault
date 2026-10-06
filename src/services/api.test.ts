import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, probeBackend, rotateBackendRequestScope, StaleBackendRequestError } from './api';

describe('apiFetch', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    rotateBackendRequestScope();
  });

  it('adds the stored API token as a header without putting it in the URL', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('top-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await apiFetch('https://streamvault.test', '/api/recordings');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://streamvault.test/api/recordings');
    expect(String(url)).not.toContain('top-secret');
    expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('top-secret');
  });

  it('supports legacy raw stored tokens and preserves an explicit caller token', async () => {
    localStorage.setItem('streamvault_auth_token', 'legacy-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await apiFetch('', '/api/config');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-streamvault-token')).toBe('legacy-token');

    await apiFetch('', '/api/config', { headers: { 'x-streamvault-token': 'request-token' } });
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-streamvault-token')).toBe('request-token');
  });

  it('preserves caller headers and accepts an empty successful response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));

    await expect(apiFetch('', '/api/recordings/r1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })).resolves.toBeUndefined();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Content-Type')).toBe('application/json');
  });

  it('turns an opaque browser network failure into an actionable backend error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiFetch('http://192.168.1.20:3002', '/api/status'))
      .rejects.toThrow(
        'Cannot reach the StreamVault backend. Check the StreamVault Server URL and make sure the backend is running.',
      );
  });

  it('surfaces an actionable JSON validation error from the backend', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'cadenceInterval must be at least 2 for occurrence mode',
    }), { status: 400, statusText: 'Bad Request' }));

    await expect(apiFetch('', '/api/recording-rules/r1', { method: 'PUT' }))
      .rejects.toThrow('cadenceInterval must be at least 2 for occurrence mode');
  });

  it('retains Retry-After metadata on an unavailable API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"Warming up"}', {
      status: 503, headers: { 'Retry-After': '3' },
    }));
    await expect(apiFetch('', '/api/live/live_future/authorize')).rejects.toMatchObject({
      status: 503, message: 'Warming up', retryAfter: '3',
    });
  });

  it('probes an untrusted backend candidate without disclosing the stored API token', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('old-backend-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await probeBackend('http://candidate.example.test:3002');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://candidate.example.test:3002/api/status');
    expect(new Headers(init?.headers).has('x-streamvault-token')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('rejects an old backend error body after the request scope rotates', async () => {
    let resolveBody!: (text: string) => void;
    const response = new Response(null, { status: 503 });
    vi.spyOn(response, 'text').mockReturnValue(new Promise<string>(resolve => { resolveBody = resolve; }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const oldRequest = apiFetch('https://backend-a.test', '/api/live/live_future/authorize');
    const result = expect(oldRequest).rejects.toBeInstanceOf(StaleBackendRequestError);
    await vi.waitFor(() => expect(response.text).toHaveBeenCalled());
    rotateBackendRequestScope();
    resolveBody('{"error":"Warming up"}');
    await result;
  });

  it.each([401, 403])('prefers stale scope over %s headers when the backend rotates before consumption', async status => {
    let resolveResponse!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(resolve => {
      resolveResponse = resolve;
    }));
    const response = new Response(null, { status });
    const text = vi.spyOn(response, 'text').mockReturnValue(new Promise<string>(() => {}));
    const result = expect(apiFetch('https://backend-a.test', '/api/config'))
      .rejects.toBeInstanceOf(StaleBackendRequestError);

    resolveResponse(response);
    // fetchBackend sees the current scope; rotate before apiFetch consumes headers.
    await Promise.resolve();
    rotateBackendRequestScope();
    await result;
    expect(text).not.toHaveBeenCalled();
  });

  it('preserves the caller cancellation error and signal', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('Caller cancelled', 'AbortError');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cancellation);
    await expect(apiFetch('', '/api/config', { signal: controller.signal })).rejects.toBe(cancellation);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([null, '', 'override-token'])('honors tokenOverride=%s rather than the stored token', async tokenOverride => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('stored-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    await apiFetch('', '/api/config', undefined, tokenOverride);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-streamvault-token'))
      .toBe(tokenOverride || null);
  });

  it('rejects an old backend response after the request scope rotates', async () => {
    let resolveOld!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveOld = resolve;
    }));

    const oldRequest = apiFetch('http://backend-a.test:3002', '/api/config');
    await Promise.resolve();
    rotateBackendRequestScope();
    resolveOld(new Response(JSON.stringify({ backend: 'a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(oldRequest).rejects.toBeInstanceOf(StaleBackendRequestError);
  });
});

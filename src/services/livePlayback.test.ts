import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthorizedLiveHlsUrl } from './livePlayback';
import { ApiError, rotateBackendRequestScope, StaleBackendRequestError } from './api';

const json = (body: unknown, status = 200, retryAfter?: string) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
});

describe('live HLS native-player authorization', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); rotateBackendRequestScope(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([503, 429])('retries cold %s authorization after Retry-After without dropping the token', async status => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('test-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, status, '3'))
      .mockResolvedValueOnce(json({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }));
    const result = getAuthorizedLiveHlsUrl('https://dvr.example.test', 'live_future', 'https://app.example.test');
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('https://dvr.example.test/api/live/live_future/index.m3u8?ticket=synthetic');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://dvr.example.test/api/live/live_future/authorize');
      expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('test-secret');
    }
  });

  it('honors an HTTP-date Retry-After rather than retrying early', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, 'Thu, 01 Jan 2026 00:00:04 GMT'))
      .mockResolvedValueOnce(json({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }));
    const result = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test');
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toContain('/api/live/live_future/index.m3u8');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an old backend after rotation during Retry-After', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ error: 'Warming up' }, 503, '3'));
    const result = getAuthorizedLiveHlsUrl('https://backend-a.test', 'live_future', 'https://app.example.test');
    const outcome = result.catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    rotateBackendRequestScope();
    localStorage.setItem('streamvault_auth_token', JSON.stringify('new-backend-token'));
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(StaleBackendRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a superseded playback generation during Retry-After', async () => {
    let current = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ error: 'Warming up' }, 503, '3'));
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test', {
      isCurrent: () => current,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    current = false;
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an earlier authorization when a newer channel authorization starts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ error: 'Warming up' }, 503, '3'))
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '3'))
      .mockResolvedValueOnce(json({ playlistUrl: '/api/live/new_channel/index.m3u8?ticket=synthetic' }));
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test').catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    await expect(getAuthorizedLiveHlsUrl('', 'new_channel', 'https://app.example.test')).resolves.toContain('/api/live/new_channel/');
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps cold native HLS authorization alive through a forty-second first publication', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '40'))
      .mockResolvedValueOnce(json({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }));
    const result = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test');
    await vi.advanceTimersByTimeAsync(39_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toContain('/api/live/live_future/index.m3u8');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled cold retry including network time to 50 seconds', async () => {
    let retrySignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '3'))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        retrySignal = init?.signal ?? undefined;
        retrySignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
    let settled = false;
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test')
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(46_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await outcome).toBeNull();
    expect(retrySignal?.aborted).toBe(true);
  });

  it.each([401, 403])('never downgrades a %s authentication rejection after a transient failure', async status => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '1'))
      .mockResolvedValueOnce(json({ error: 'Access rejected' }, status));
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test').catch(error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])('rejects %s headers after 503 immediately even when the auth body never arrives', async status => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('test-secret'));
    const response = new Response(null, { status });
    const text = vi.spyOn(response, 'text').mockReturnValue(new Promise<string>(() => {}));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '1'))
      .mockResolvedValueOnce(response);
    const settled = vi.fn();
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test')
      .then(value => settled({ value }), error => settled({ error }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ error: expect.any(ApiError) });
    expect(settled.mock.calls[0][0].error).toMatchObject({ status });
    expect(text).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(49_000);
    await outcome;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ error: expect.any(ApiError) });
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('test-secret');
    }
  });

  it.each([undefined, 'nonsense', '0'])('uses a bounded non-spinning retry for Retry-After=%s', async retryAfter => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ error: 'Warming up' }, 503, retryAfter));
    const start = Date.now();
    const result = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(50);
    expect(Date.now() - start).toBeLessThanOrEqual(50_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry earlier than a Retry-After beyond the authorization budget', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'Busy' }, 429, '60'));
    await expect(getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat an initial stalled transport as permission to downgrade authentication', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const outcome = getAuthorizedLiveHlsUrl('', 'live_future', 'https://app.example.test').catch(error => error);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await outcome).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'https://other.example.test/api/live/live_future/index.m3u8',
    '/api/live/another/index.m3u8',
    '//dvr.example.test/api/live/live_future/index.m3u8',
  ])('retains playlist validation after a retry for %s', async playlistUrl => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'Warming up' }, 503, '1'))
      .mockResolvedValueOnce(json({ playlistUrl }));
    const outcome = getAuthorizedLiveHlsUrl('https://dvr.example.test', 'live_future', 'https://app.example.test').catch(error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches a signed feed with the stored token and keeps it on the configured backend', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('test-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }));
    await expect(getAuthorizedLiveHlsUrl('https://dvr.example.test', 'live_future', 'file://')).resolves.toBe('https://dvr.example.test/api/live/live_future/index.m3u8?ticket=synthetic');
    expect(fetchMock.mock.calls[0][0]).toBe('https://dvr.example.test/api/live/live_future/authorize');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-streamvault-token')).toBe('test-secret');
  });

  it('retains the TS fallback for an unavailable or overloaded HLS feed without authentication', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const status of [404, 429, 503]) {
      fetchMock.mockImplementation(async () => json({ error: 'Unavailable' }, status));
      const result = expect(getAuthorizedLiveHlsUrl('', 'live_future', 'http://localhost:3000')).resolves.toBeNull();
      await vi.runAllTimersAsync();
      await result;
    }
  });

  it('falls back to legacy TS when a protected feed is overloaded, but never downgrades authentication rejection', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('test-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async () => json({ error: 'Worker capacity' }, 503));
    const result = expect(getAuthorizedLiveHlsUrl('', 'live_future', 'http://localhost:3000')).resolves.toBeNull();
    await vi.runAllTimersAsync();
    await result;
    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthenticated' }, 401));
    await expect(getAuthorizedLiveHlsUrl('', 'live_future', 'http://localhost:3000')).rejects.toThrow();
  });

  it('rejects a cross-origin or different-channel playlist from the authorization response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(json({ playlistUrl: 'https://other.example.test/steal' }));
    await expect(getAuthorizedLiveHlsUrl('https://dvr.example.test', 'live_future', 'https://app.example.test')).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(json({ playlistUrl: '/api/live/another/index.m3u8?ticket=synthetic' }));
    await expect(getAuthorizedLiveHlsUrl('https://dvr.example.test', 'live_future', 'https://app.example.test')).rejects.toThrow();
  });
});

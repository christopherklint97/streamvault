import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, rotateBackendRequestScope } from './api';

describe('opt-in API deadlines', () => {
  beforeEach(() => { vi.useFakeTimers(); rotateBackendRequestScope(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('bounds a stalled response body and aborts the transport', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'text').mockReturnValue(new Promise(() => {}));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    let failure: unknown;
    const request = apiFetch('', '/api/config', { timeoutMs: 100 }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toMatchObject({ name: 'ApiTimeoutError', message: expect.stringContaining('Retry') });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled headers without AbortController support', async () => {
    vi.stubGlobal('AbortController', undefined);
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    let failure: unknown;
    const request = apiFetch('', '/api/config', { timeoutMs: 100 }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toMatchObject({ name: 'ApiTimeoutError' });
    await request;
  });

  it('does not impose a default deadline on streaming authorization', async () => {
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    const request = apiFetch('', '/api/live-compatible/live_1/authorize');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    resolve(new Response('{"playlistUrl":"/media"}'));
    await expect(request).resolves.toEqual({ playlistUrl: '/media' });
  });

  it.each(['caller', 'backend'])('cancels a stalled body on %s cancellation and clears the deadline', async source => {
    const caller = new AbortController();
    const response = new Response('{}');
    vi.spyOn(response, 'text').mockReturnValue(new Promise(() => {}));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const request = apiFetch('', '/api/config', { timeoutMs: 100, signal: caller.signal });
    const result = expect(request).rejects.toMatchObject({ name: source === 'caller' ? 'AbortError' : 'StaleBackendRequestError' });
    await vi.advanceTimersByTimeAsync(1);
    if (source === 'caller') caller.abort();
    else rotateBackendRequestScope();
    await result;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])('keeps %s terminal before a stalled error body', async status => {
    const response = new Response(null, { status });
    const text = vi.spyOn(response, 'text').mockReturnValue(new Promise(() => {}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(apiFetch('', '/api/config', { timeoutMs: 100 })).rejects.toMatchObject({ status });
    expect(text).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline and signal listeners after successful JSON', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
    await expect(apiFetch('', '/api/config', { timeoutMs: 100, signal: caller.signal })).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

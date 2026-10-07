import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { rotateBackendRequestScope } from '../services/api';

describe('bounded backend bootstrap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rotateBackendRequestScope();
    useChannelStore.setState({ apiBaseUrl: '', backendGeneration: 0, backendConnection: 'unknown', _hydrated: false, error: null, isLoading: false, isCrawling: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(['status', 'config'])('finishes startup with an actionable error when %s never responds', async stalled => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).endsWith(`/api/${stalled}`)) return new Promise(() => {});
      return Promise.resolve(new Response('{"isSyncing":false}'));
    });
    const startup = useChannelStore.getState().hydrate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useChannelStore.getState()).toMatchObject({ _hydrated: true, backendConnection: 'disconnected', error: expect.stringContaining('Retry') });
    await startup;
  });

  it.each(['status', 'config'])('bounds a candidate %s bootstrap without replacing the active backend', async stalled => {
    useChannelStore.setState({ backendConnection: 'connected', _hydrated: true, apiBaseUrl: 'https://active.test' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      if (String(input).endsWith(`/api/${stalled}`)) return new Promise(() => {});
      return Promise.resolve(new Response('{}'));
    });
    let result: boolean | undefined;
    const attempt = useChannelStore.getState().connectBackend('https://candidate.test').then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBe(false);
    expect(useChannelStore.getState()).toMatchObject({ apiBaseUrl: 'https://active.test', backendConnection: 'connected', error: expect.stringContaining('Retry') });
    await attempt;
  });

  it('allows an explicit retry after failed startup and shows connection in progress', async () => {
    useChannelStore.setState({ _hydrated: true, backendConnection: 'disconnected', error: 'Previous timeout' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(JSON.stringify(
      String(input).endsWith('/api/status') ? { channelCount: 23, contentTypeCounts: { livetv: 23 } } : {},
    )));
    const retry = useChannelStore.getState().hydrate(true);
    expect(useChannelStore.getState()).toMatchObject({ _hydrated: false, backendConnection: 'unknown', error: null });
    await retry;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useChannelStore.getState()).toMatchObject({ _hydrated: true, backendConnection: 'connected', contentTypeCounts: { livetv: 23 }, error: null });
  });
});

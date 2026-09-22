import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { rotateBackendRequestScope } from '../services/api';

describe('commercial auto-skip config', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    rotateBackendRequestScope();
    useChannelStore.setState({
      apiBaseUrl: '',
      backendConnection: 'disconnected',
      backendGeneration: 0,
      _hydrated: false,
      inputMode: 'manual',
      playlistUrl: 'https://example.test/list.m3u',
      epgUrl: 'https://example.test/guide.xml',
      xtreamCredentials: { serverUrl: 'https://provider.test', username: 'user', password: 'pass' },
      syncInterval: '6h',
      commercialAutoSkip: false,
      error: null,
    });
  });

  it('hydrates a partial commercial setting without overwriting unrelated config fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ commercialAutoSkip: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await useChannelStore.getState().fetchConfig();

    expect(useChannelStore.getState()).toMatchObject({
      inputMode: 'manual',
      playlistUrl: 'https://example.test/list.m3u',
      epgUrl: 'https://example.test/guide.xml',
      xtreamCredentials: { serverUrl: 'https://provider.test', username: 'user', password: 'pass' },
      syncInterval: '6h',
      commercialAutoSkip: true,
    });
  });

  it('saves only the requested commercial setting and preserves local unrelated fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(useChannelStore.getState().saveConfig({ commercialAutoSkip: true })).resolves.toBe(true);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ commercialAutoSkip: true });
    expect(useChannelStore.getState()).toMatchObject({
      playlistUrl: 'https://example.test/list.m3u',
      syncInterval: '6h',
      commercialAutoSkip: true,
    });
  });

  it('keeps a small forward program window refreshed across airing boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ programs: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await useChannelStore.getState().fetchPrograms();

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'https://streamvault.test');
    expect(requestUrl.pathname).toBe('/api/programs');
    expect(requestUrl.searchParams.get('from')).toBe('1000000');
    expect(requestUrl.searchParams.get('to')).toBe('2800000');

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reports failure and leaves commercial auto-skip unchanged when persistence fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500, statusText: 'Broken' }));

    await expect(useChannelStore.getState().saveConfig({ commercialAutoSkip: true })).resolves.toBe(false);

    expect(useChannelStore.getState().commercialAutoSkip).toBe(false);
    expect(useChannelStore.getState().error).toContain('500');
  });

  it('preserves the active backend when a candidate status probe fails', async () => {
    localStorage.setItem('streamvault_api_url', JSON.stringify('http://old-backend.test:3002'));
    localStorage.setItem('streamvault_auth_token', JSON.stringify('old-backend-secret'));
    useChannelStore.setState({
      apiBaseUrl: 'http://old-backend.test:3002',
      backendConnection: 'connected',
      error: null,
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(useChannelStore.getState().connectBackend('http://candidate.test:3002'))
      .resolves.toBe(false);

    expect(localStorage.getItem('streamvault_api_url')).toBe(JSON.stringify('http://old-backend.test:3002'));
    expect(localStorage.getItem('streamvault_auth_token')).toBe(JSON.stringify('old-backend-secret'));
    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://old-backend.test:3002',
      backendConnection: 'connected',
      xtreamCredentials: { serverUrl: 'https://provider.test', username: 'user', password: 'pass' },
      error: 'Cannot reach the StreamVault backend. Check the StreamVault Server URL and make sure the backend is running.',
    });
  });

  it('rolls back a candidate whose bootstrap requests fail after a successful probe', async () => {
    localStorage.setItem('streamvault_api_url', JSON.stringify('http://old-backend.test:3002'));
    localStorage.setItem('streamvault_auth_token', JSON.stringify('old-backend-secret'));
    useChannelStore.setState({
      apiBaseUrl: 'http://old-backend.test:3002',
      backendConnection: 'connected',
      error: null,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return new Response('nope', { status: 500, statusText: 'Broken' });
      }
      const body = url.includes('/api/programs') ? { programs: [] } : { isSyncing: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(useChannelStore.getState().connectBackend('http://candidate.test:3002'))
      .resolves.toBe(false);

    expect(localStorage.getItem('streamvault_api_url')).toBe(JSON.stringify('http://old-backend.test:3002'));
    expect(localStorage.getItem('streamvault_auth_token')).toBe(JSON.stringify('old-backend-secret'));
    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://old-backend.test:3002',
      backendConnection: 'connected',
      playlistUrl: 'https://example.test/list.m3u',
      epgUrl: 'https://example.test/guide.xml',
      xtreamCredentials: { serverUrl: 'https://provider.test', username: 'user', password: 'pass' },
      error: 'API error: 500 Broken',
    });
  });

  it('persists a backend URL and unlocks provider settings only after hydration succeeds', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('old-backend-secret'));
    useChannelStore.setState({ apiBaseUrl: 'http://old-backend.test:3002' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('/api/config')
        ? {}
        : url.includes('/api/programs')
          ? { programs: [] }
          : { isSyncing: false, contentTypeCounts: {} };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(useChannelStore.getState().connectBackend('http://192.168.1.20:3002'))
      .resolves.toBe(true);

    expect(localStorage.getItem('streamvault_api_url')).toBe(JSON.stringify('http://192.168.1.20:3002'));
    expect(localStorage.getItem('streamvault_auth_token')).toBeNull();
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has('x-streamvault-token')).toBe(false);
    }
    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://192.168.1.20:3002',
      backendConnection: 'connected',
      playlistUrl: '',
      epgUrl: '',
      xtreamCredentials: { serverUrl: '', username: '', password: '' },
      error: null,
      _hydrated: true,
    });
  });

  it('uses only the candidate token while onboarding an auth-protected backend', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('old-backend-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const token = new Headers(init?.headers).get('x-streamvault-token');
      if (url.endsWith('/api/status')) {
        expect(token).toBeNull();
        return new Response(JSON.stringify({ phase: 'idle', isSyncing: false, isCrawling: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect(token).toBe('new-backend-token');
      const body = url.endsWith('/api/config')
        ? { inputMode: 'manual', playlistUrl: 'https://new/list.m3u' }
        : { programs: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(useChannelStore.getState().connectBackend(
      'http://protected.test:3002',
      'new-backend-token',
    )).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem('streamvault_auth_token')).toBe(JSON.stringify('new-backend-token'));
    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://protected.test:3002',
      backendConnection: 'connected',
      playlistUrl: 'https://new/list.m3u',
    });
  });

  it('keeps provider settings locked when startup bootstrap is only partially successful', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/status')) {
        return new Response(JSON.stringify({ phase: 'idle', isSyncing: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/config')) return new Response('', { status: 500, statusText: 'Broken' });
      return new Response(JSON.stringify({ programs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    useChannelStore.setState({
      apiBaseUrl: 'http://backend.test:3002',
      backendConnection: 'unknown',
      error: null,
      _hydrated: false,
    });

    await useChannelStore.getState().hydrate();

    expect(useChannelStore.getState()).toMatchObject({
      backendConnection: 'disconnected',
      error: 'API error: 500 Broken',
      _hydrated: true,
    });
  });

  it('ignores a failed hydration after the user has selected another backend', async () => {
    let rejectOldBackend!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((_resolve, reject) => {
      rejectOldBackend = reject;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://old-backend.test:3002',
      backendConnection: 'unknown',
      error: null,
      _hydrated: false,
    });

    const oldHydration = useChannelStore.getState().hydrate();
    await Promise.resolve();
    useChannelStore.setState({
      apiBaseUrl: 'http://new-backend.test:3002',
      backendConnection: 'connected',
      backendGeneration: 1,
      error: null,
      _hydrated: true,
    });
    rejectOldBackend(new TypeError('Failed to fetch'));
    await oldHydration;

    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://new-backend.test:3002',
      backendConnection: 'connected',
      error: null,
      _hydrated: true,
    });
  });

  it('ignores a stale program-fetch failure after the backend changes', async () => {
    let rejectOldBackend!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((_resolve, reject) => {
      rejectOldBackend = reject;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://old-backend.test:3002',
      error: null,
    });

    const oldPrograms = useChannelStore.getState().fetchPrograms();
    await Promise.resolve();
    useChannelStore.setState({ apiBaseUrl: 'http://new-backend.test:3002', backendGeneration: 1, error: null });
    rejectOldBackend(new TypeError('Failed to fetch'));
    await oldPrograms;

    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://new-backend.test:3002',
      error: null,
    });
  });

  it('rejects an ABA response from an earlier generation of the same backend URL', async () => {
    let resolveFirstA!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveFirstA = resolve;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-a.test:3002',
      backendGeneration: 0,
      programs: [],
      error: null,
    });

    const firstA = useChannelStore.getState().fetchPrograms();
    await Promise.resolve();
    useChannelStore.setState({ apiBaseUrl: 'http://backend-b.test:3002', backendGeneration: 1 });
    useChannelStore.setState({ apiBaseUrl: 'http://backend-a.test:3002', backendGeneration: 2 });
    resolveFirstA(new Response(JSON.stringify({
      programs: [{
        channelId: 'stale', title: 'Stale', description: '',
        start: '2026-01-01T00:00:00Z', stop: '2026-01-01T01:00:00Z', category: '',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await firstA;

    expect(useChannelStore.getState().programs).toEqual([]);
  });

  it('does not return channels from a backend generation that changed during lookup', async () => {
    useChannelStore.setState({ apiBaseUrl: 'http://backend-a.test:3002', backendGeneration: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      useChannelStore.setState({ apiBaseUrl: 'http://backend-b.test:3002', backendGeneration: 1 });
      return new Response(JSON.stringify({ channels: [{ id: 'old-channel' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(useChannelStore.getState().fetchChannelsByIds(['old-channel'])).resolves.toEqual([]);
  });

  it('does not merge EPG data from a backend generation that changed during lookup', async () => {
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-a.test:3002',
      backendGeneration: 0,
      programsByChannel: new Map(),
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      useChannelStore.setState({ apiBaseUrl: 'http://backend-b.test:3002', backendGeneration: 1 });
      return new Response(JSON.stringify({
        programs: [{
          channelId: 'old-channel', title: 'Old show', description: '',
          start: '2026-01-01T00:00:00Z', stop: '2026-01-01T01:00:00Z', category: '',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await expect(useChannelStore.getState().fetchEpgForStream(1)).resolves.toEqual([]);
    expect(useChannelStore.getState().programsByChannel.size).toBe(0);
  });

  it('ignores a stale config save after the backend changes', async () => {
    let resolveOldSave!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveOldSave = resolve;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-a.test:3002',
      backendGeneration: 0,
      backendConnection: 'connected',
      inputMode: 'manual',
      error: null,
    });

    const oldSave = useChannelStore.getState().saveConfig({ inputMode: 'xtream' });
    await Promise.resolve();
    rotateBackendRequestScope();
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-b.test:3002',
      backendGeneration: 1,
      backendConnection: 'connected',
      inputMode: 'manual',
      error: null,
    });
    resolveOldSave(new Response(null, { status: 204 }));

    await expect(oldSave).resolves.toBe(false);
    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://backend-b.test:3002',
      backendConnection: 'connected',
      inputMode: 'manual',
      error: null,
    });
  });

  it('ignores a stale crawl failure after the backend changes', async () => {
    let resolveOldCrawl!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveOldCrawl = resolve;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-a.test:3002',
      backendGeneration: 0,
      isCrawling: false,
      crawlProgress: '',
    });

    const oldCrawl = useChannelStore.getState().triggerCrawl();
    await Promise.resolve();
    rotateBackendRequestScope();
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-b.test:3002',
      backendGeneration: 1,
      isCrawling: true,
      crawlProgress: 'New backend crawl',
    });
    resolveOldCrawl(new Response(null, { status: 202 }));
    await oldCrawl;

    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://backend-b.test:3002',
      isCrawling: true,
      crawlProgress: 'New backend crawl',
    });
  });

  it('ignores status polling results from the previous backend generation', async () => {
    let resolveOldPoll!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveOldPoll = resolve;
    }));
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-a.test:3002',
      backendGeneration: 0,
      isLoading: false,
      isCrawling: false,
      channelCount: 7,
    });

    const oldPoll = useChannelStore.getState().pollStatus();
    await Promise.resolve();
    useChannelStore.setState({
      apiBaseUrl: 'http://backend-b.test:3002',
      backendGeneration: 1,
      isLoading: false,
      isCrawling: false,
      channelCount: 3,
    });
    resolveOldPoll(new Response(JSON.stringify({
      phase: 'parsing',
      message: 'Old backend syncing',
      isSyncing: true,
      isCrawling: true,
      channelCount: 999,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await oldPoll;

    expect(useChannelStore.getState()).toMatchObject({
      apiBaseUrl: 'http://backend-b.test:3002',
      backendGeneration: 1,
      isLoading: false,
      isCrawling: false,
      channelCount: 3,
    });
  });
});

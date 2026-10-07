import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelStore } from './channelStore';

describe('commercial auto-skip config', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useChannelStore.setState({
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

  it('reports failure and leaves commercial auto-skip unchanged when persistence fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500, statusText: 'Broken' }));

    await expect(useChannelStore.getState().saveConfig({ commercialAutoSkip: true })).resolves.toBe(false);

    expect(useChannelStore.getState().commercialAutoSkip).toBe(false);
    expect(useChannelStore.getState().error).toContain('500');
  });
});

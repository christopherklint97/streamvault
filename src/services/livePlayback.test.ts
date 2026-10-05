import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthorizedLiveHlsUrl } from './livePlayback';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('live HLS native-player authorization', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

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
      fetchMock.mockResolvedValueOnce(json({ error: 'Unavailable' }, status));
      await expect(getAuthorizedLiveHlsUrl('', 'live_future', 'http://localhost:3000')).resolves.toBeNull();
    }
  });

  it('falls back to legacy TS when a protected feed is overloaded, but never downgrades authentication rejection', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('test-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(json({ error: 'Worker capacity' }, 503));
    await expect(getAuthorizedLiveHlsUrl('', 'live_future', 'http://localhost:3000')).resolves.toBeNull();
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

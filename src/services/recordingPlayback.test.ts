import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecordingPlaybackUrl, getRecordingVodStatus } from './recordingPlayback';

function json(body: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('authenticated recording playback tickets', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('requests a ticket with authenticated apiFetch and resolves a relative URL against a cross-origin API base', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('raw-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      url: '/api/recordings/r1/play?ticket=one-time',
      expiresAt: Date.now() + 60_000,
    }));

    await expect(getRecordingPlaybackUrl({
      apiBaseUrl: 'https://dvr.example.test',
      recordingId: 'r1',
      directUrl: '/api/recordings/r1/play',
      pageOrigin: 'https://app.example.test',
    })).resolves.toBe('https://dvr.example.test/api/recordings/r1/play?ticket=one-time');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dvr.example.test/api/recordings/r1/playback-ticket');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('raw-secret');
    expect(String(url)).not.toContain('raw-secret');
  });

  it('keeps same-origin ticket URLs relative', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      url: '/api/recordings/r1/play?ticket=one-time',
      expiresAt: Date.now() + 60_000,
    }));

    await expect(getRecordingPlaybackUrl({
      apiBaseUrl: '',
      recordingId: 'r1',
      directUrl: '/api/recordings/r1/play',
      pageOrigin: 'https://app.example.test',
    })).resolves.toBe('/api/recordings/r1/play?ticket=one-time');
  });

  it('reads a seekable recording status with the configured API credentials', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'ready' }));
    await expect(getRecordingVodStatus('https://dvr.example.test', 'r1')).resolves.toBe('ready');
    expect(fetchMock.mock.calls[0][0]).toBe('https://dvr.example.test/api/recordings/r1/vod-status');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-streamvault-token')).toBe('secret');
  });

  it('falls back only for an unavailable ticket endpoint when no authentication token is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'not found' }, 404, 'Not Found'));

    await expect(getRecordingPlaybackUrl({
      apiBaseUrl: 'https://dvr.example.test',
      recordingId: 'r1',
      directUrl: '/api/recordings/r1/play',
      pageOrigin: 'https://app.example.test',
    })).resolves.toBe('https://dvr.example.test/api/recordings/r1/play');
  });

  it('does not expose a direct URL for server errors or when authentication is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'broken' }, 500, 'Broken'));
    const request = {
      apiBaseUrl: '', recordingId: 'r1', directUrl: '/direct/raw', pageOrigin: 'https://app.example.test',
    };
    await expect(getRecordingPlaybackUrl(request)).rejects.toThrow('broken');

    localStorage.setItem('streamvault_auth_token', JSON.stringify('secret'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'not found' }, 404, 'Not Found'));
    await expect(getRecordingPlaybackUrl(request)).rejects.toThrow('not found');
  });
});

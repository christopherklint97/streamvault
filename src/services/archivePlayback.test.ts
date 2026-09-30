import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getArchivePlayback, getArchiveChannels, setArchiveChannel, getRecordingHlsPlayback } from './archivePlayback';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('finite archive and recording playback', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('gets a signed finite snapshot through the authenticated API and preserves its timeline', async () => {
    localStorage.setItem('streamvault_auth_token', JSON.stringify('app-secret'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      url: '/api/archive/snapshots/s1/index.m3u8?ticket=scoped', expiresAt: 123456,
      startTime: 1_000_000, endTime: 1_060_000, duration: 60,
      snapshotId: 's1', gaps: [],
    }));
    await expect(getArchivePlayback({ apiBaseUrl: 'https://pi.example', channelId: 'live_7',
      startTime: 1_000_000, endTime: 1_060_000, pageOrigin: 'https://app.example',
    })).resolves.toMatchObject({ url: 'https://pi.example/api/archive/snapshots/s1/index.m3u8?ticket=scoped', duration: 60 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://pi.example/api/archive/live_7/playback-ticket');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ startTime: 1_000_000, endTime: 1_060_000 }));
    expect(new Headers(init?.headers).get('x-streamvault-token')).toBe('app-secret');
    expect(String(url)).not.toContain('app-secret');
  });

  it('refuses an empty/non-finite snapshot instead of pretending the stream is LIVE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ url: '/api/archive/s1/index.m3u8', duration: 0 }));
    await expect(getArchivePlayback({ apiBaseUrl: '', channelId: 'live_7', startTime: 1, endTime: 2,
      pageOrigin: 'https://app.example', })).rejects.toThrow(/seekable/i);
  });

  it('lists channel archive coverage and sets the 24-hour policy explicitly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ archives: [{ channelId: 'live_7', channelName: 'ESPN', enabled: true,
        retentionHours: 24, status: 'capturing', lastPublishedAt: 123, availableFrom: 12, availableTo: 123,
        diskUsageBytes: 1024 }] }))
      .mockResolvedValueOnce(json({ archive: { channelId: 'live_7', channelName: 'ESPN', enabled: false,
        retentionHours: 24, status: 'disabled', lastPublishedAt: null, availableFrom: null,
        availableTo: null, diskUsageBytes: 0 } }));
    await expect(getArchiveChannels('')).resolves.toHaveLength(1);
    await expect(setArchiveChannel('', 'live_7', { channelName: 'ESPN', enabled: false, retentionHours: 24 }))
      .resolves.toMatchObject({ enabled: false });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/archives/live_7');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ channelName: 'ESPN', enabled: false, retentionHours: 24 }));
  });

  it('gets finite HLS for a new recording without changing legacy ticket fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ url: '/api/recordings/r1/index.m3u8?ticket=short',
      expiresAt: 123456, duration: 3600 }));
    await expect(getRecordingHlsPlayback({ apiBaseUrl: '', recordingId: 'r1',
      pageOrigin: 'https://app.example' })).resolves.toMatchObject({
      url: '/api/recordings/r1/index.m3u8?ticket=short', duration: 3600,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { CACHEABLE_API_PATTERN } from '../pwa-cache';

describe('CACHEABLE_API_PATTERN', () => {
  it.each([
    '/api/live-compatible',
    '/api/live-compatible?probe=1',
    '/api/live-compatible/live_1/authorize',
    '/api/live-compatible/live_1/index.m3u8?ticket=synthetic',
    '/api/live-compatible/live_1/segment/123.ts?ticket=synthetic',
    'https://streamvault.test/api/LIVE-COMPATIBLE/live_1/index.m3u8?ticket=synthetic',
  ])('never caches native compatibility delivery: %s', path => {
    expect(CACHEABLE_API_PATTERN.test(path)).toBe(false);
  });

  it.each([
    '/api/browse?type=movies&limit=20',
    '/api/categories?type=livetv',
    '/api/channels?group=News',
    '/api/search?q=matrix&type=movies',
    '/api/vod/123',
    '/api/series/456',
    '/api/epg/batch?ids=live_1',
    '/api/epg/channel/live_1?from=1&to=2',
  ])('caches catalogue metadata: %s', path => {
    expect(CACHEABLE_API_PATTERN.test(path)).toBe(true);
  });

  it('excludes transient media delivery endpoints from the service-worker cache', () => {
    for (const path of [
      '/api/status',
      '/api/config',
      '/api/programs?from=1&to=2',
      '/api/stream/vod_1',
      '/api/live/live_future/authorize',
      '/api/live/live_future/index.m3u8?ticket=synthetic',
      '/api/live/live_future/segment/123.ts?ticket=synthetic',
      '/api/LIVE/live_future/index.m3u8?ticket=synthetic',
      '/API/LiVe/live_future/segment/123.ts?ticket=synthetic',
      '/api/proxy/example',
      '/api/remux/vod_1',
      '/api/transcode/vod_1',
      '/api/subtitles/episode_1?url=http%3A%2F%2Fprovider.example%2Fepisode.mkv',
      '/api/subtitles/episode_1/3.vtt?url=http%3A%2F%2Fprovider.example%2Fepisode.mkv',
      '/api/recordings/recording_1',
      '/api/recording-rules',
      '/api/recording-rules/rule_1',
      '/api/recording-status',
      '/api/recordings/recording_1/commercial-segments',
      '/api/ios-hls/vod_1/index.m3u8',
      '/api/ios-hls-authorize/vod_1/index.m3u8',
      '/api/ios-hls-assets/session/init.mp4',
      '/api/archive/live_1/chunk_0001.ts',
      '/api/archives',
      '/api/archives/archive_1',
      '/api/player?channel=live_1',
      '/api/player/live_1',
      '/api/health',
      '/api/client-logs',
      '/api/browser',
      '/api/vodka',
    ]) {
      expect(CACHEABLE_API_PATTERN.test(path), path).toBe(false);
    }
  });
});

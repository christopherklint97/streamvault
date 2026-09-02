import { describe, expect, it } from 'vitest';
import { CACHEABLE_API_PATTERN } from '../pwa-cache';

describe('CACHEABLE_API_PATTERN', () => {
  it('excludes transient media delivery endpoints from the service-worker cache', () => {
    expect(CACHEABLE_API_PATTERN.test('/api/config')).toBe(true);
    for (const path of [
      '/api/stream/vod_1',
      '/api/proxy/example',
      '/api/remux/vod_1',
      '/api/transcode/vod_1',
      '/api/recordings/recording_1',
      '/api/ios-hls/vod_1/index.m3u8',
      '/api/ios-hls-authorize/vod_1/index.m3u8',
      '/api/ios-hls-assets/session/init.mp4',
    ]) {
      expect(CACHEABLE_API_PATTERN.test(path), path).toBe(false);
    }
  });
});

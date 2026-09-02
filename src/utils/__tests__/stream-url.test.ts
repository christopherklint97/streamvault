import { describe, expect, it } from 'vitest';
import { browserTranscodePath, iphoneVodPlaybackPath, iosHlsPath, toAbsolutePlayerUrl, vodRemuxPath } from '../stream-url';

describe('toAbsolutePlayerUrl', () => {
  it('turns a same-origin proxy path into an absolute URL for AVPlay', () => {
    expect(toAbsolutePlayerUrl('/api/stream/vod_1467994', '', 'http://192.168.1.5:3002')).toBe(
      'http://192.168.1.5:3002/api/stream/vod_1467994'
    );
  });

  it('preserves an explicitly configured server URL', () => {
    expect(toAbsolutePlayerUrl('/api/stream/vod_1467994', 'http://media.example:3002', 'http://192.168.1.5:3002')).toBe(
      'http://media.example:3002/api/stream/vod_1467994'
    );
  });

  it('builds the VOD remux endpoint from the channel ID', () => {
    expect(vodRemuxPath('vod_1467994')).toBe('/api/remux/vod_1467994');
  });

  it('builds a transcoder URL for an episode source URL', () => {
    expect(browserTranscodePath('episode_177574', 'http://provider.example/episode.mkv')).toBe(
      '/api/transcode/episode_177574?url=http%3A%2F%2Fprovider.example%2Fepisode.mkv'
    );
  });

  it('adds a start offset when restarting a browser transcode to seek', () => {
    expect(browserTranscodePath('episode_177574', 'http://provider.example/episode.mkv', 120)).toBe(
      '/api/transcode/episode_177574?url=http%3A%2F%2Fprovider.example%2Fepisode.mkv&start=120'
    );
  });

  it('builds native HLS path for an iPhone episode', () => {
    expect(iosHlsPath('episode_177574', 'http://provider.example/episode.mkv')).toBe(
      '/api/ios-hls-authorize/episode_177574/index.m3u8?url=http%3A%2F%2Fprovider.example%2Fepisode.mkv'
    );
  });

  it('routes iPhone catalogue movies through native HLS', () => {
    expect(iphoneVodPlaybackPath('vod_83608', 'http://provider.example/movie.mkv', 'movies')).toBe(
      '/api/ios-hls-authorize/vod_83608/index.m3u8?url=http%3A%2F%2Fprovider.example%2Fmovie.mkv&type=movies'
    );
  });

  it('keeps iPhone recordings on their direct range-capable URL', () => {
    expect(iphoneVodPlaybackPath('recording_42', '/api/recordings/42', 'movies')).toBeNull();
  });

  it('builds a transcoder URL for a catalogue VOD', () => {
    expect(browserTranscodePath('vod_1467994')).toBe('/api/transcode/vod_1467994');
  });
});

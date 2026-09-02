import { describe, expect, it } from 'vitest';
import { buildIosHlsArgs, iosHlsContentType } from './ios-hls';

describe('buildIosHlsArgs', () => {
  it('classifies catalogue VOD as movie HLS instead of rejecting it', () => {
    expect(iosHlsContentType('vod_83608')).toBe('movies');
  });

  it('classifies manual-M3U movie IDs from the explicit content type', () => {
    expect(iosHlsContentType('1m9dt3', 'movies')).toBe('movies');
  });

  it('seeks before input when starting an HLS session at a requested time', () => {
    expect(buildIosHlsArgs('http://source', '/tmp/index.m3u8', 120)).toContain('-ss');
  });

  it('downmixes provider audio to browser-safe stereo AAC', () => {
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-ac');
    expect(args).toContain('2');
  });

  it('creates H.264/AAC fragmented-MP4 HLS for iPhone playback', () => {
    const args = buildIosHlsArgs('http://127.0.0.1:3001/api/stream/episode_177574', '/tmp/session/index.m3u8');
    expect(args).toContain('-f');
    expect(args).toContain('hls');
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-hls_segment_type');
    expect(args).toContain('fmp4');
  });
});

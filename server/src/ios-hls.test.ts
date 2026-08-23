import { describe, expect, it } from 'vitest';
import { buildIosHlsArgs } from './ios-hls';

describe('buildIosHlsArgs', () => {
  it('seeks before input when starting an HLS session at a requested time', () => {
    expect(buildIosHlsArgs('http://source', '/tmp/index.m3u8', 120)).toContain('-ss');
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

import { describe, expect, it } from 'vitest';
import { buildFragmentedMp4Args } from './vod-remux';

describe('buildFragmentedMp4Args', () => {
  it('transcodes audio to browser-safe AAC while preserving video quality', () => {
    const args = buildFragmentedMp4Args('http://provider.example/movie.mkv', false);
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-ac');
    expect(args).toContain('2');
  });

  it('marks copied HEVC video as hvc1 in streamable fragmented MP4', () => {
    expect(buildFragmentedMp4Args('http://provider.example/movie.mkv', true)).toEqual([
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'http://provider.example/movie.mkv',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov',
      '-f', 'mp4', 'pipe:1',
    ]);
  });

  it('keeps delayed moov initialization for streaming-safe fragmented output', () => {
    expect(buildFragmentedMp4Args('http://provider.example/movie.mkv', false)).toContain(
      'frag_keyframe+empty_moov+default_base_moof+delay_moov',
    );
  });

  it('leaves H.264 streams with their default avc1 tag', () => {
    expect(buildFragmentedMp4Args('http://provider.example/movie.mkv', false)).not.toContain('hvc1');
  });
});

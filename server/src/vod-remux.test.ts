import { describe, expect, it } from 'vitest';
import { buildFragmentedMp4Args } from './vod-remux';

describe('buildFragmentedMp4Args', () => {
  it('remuxes the primary video and optional audio tracks into streamable fragmented MP4', () => {
    expect(buildFragmentedMp4Args('http://provider.example/movie.mkv')).toEqual([
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'http://provider.example/movie.mkv',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildLiveMpegTsArgs } from './live-stream.js';

describe('buildLiveMpegTsArgs', () => {
  it('copies video and audio while stripping subtitles in normal live mode', () => {
    expect(buildLiveMpegTsArgs(false)).toEqual([
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+nobuffer+discardcorrupt',
      '-i', 'pipe:0',
      '-map', '0:v', '-map', '0:a?',
      '-c', 'copy', '-sn',
      '-bsf:v', 'filter_units=remove_types=6|39|40',
      '-f', 'mpegts', 'pipe:1',
    ]);
  });

  it('removes video and emits browser-compatible AAC in audio-only mode', () => {
    const args = buildLiveMpegTsArgs(true);

    expect(args).toContain('-vn');
    expect(args).toContain('0:a:0');
    expect(args).toContain('aac');
    expect(args).not.toContain('0:v');
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1']);
  });
});

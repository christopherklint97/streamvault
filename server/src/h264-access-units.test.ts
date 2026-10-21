import { describe, expect, it } from 'vitest';
import { firstCodecName, isUnsupportedBitstreamFilterError } from './h264-access-units';

describe('H.264 access unit rewrite', () => {
  it('reads the codec from ffprobe output that repeats it per program', () => {
    expect(firstCodecName('h264\nh264\n')).toBe('h264');
    expect(firstCodecName('hevc\n')).toBe('hevc');
    expect(firstCodecName('\n')).toBeNull();
  });
  it('recognises FFmpeg rejecting the filter for a non-H.264 stream', () => {
    expect(isUnsupportedBitstreamFilterError(
      "[h264_metadata @ 0x1] Codec 'mpeg2video' (2) is not supported by the bitstream filter 'h264_metadata'.")).toBe(true);
    expect(isUnsupportedBitstreamFilterError('Connection refused')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { buildRecordingHlsArgs, parseRecordingHlsStart } from './recording-hls';

describe('finite recording HLS', () => {
  it('uses bounded, paced stream-copy segments from the verified local master', () => {
    const args = buildRecordingHlsArgs('/recordings/r1.ts', '/cache/index.m3u8', 21.75);
    expect(args).toContain('21.75');
    expect(args).toContain('/recordings/r1.ts');
    expect(args).toContain('/cache/segment-%05d.ts');
    expect(args).toContain('-readrate');
    expect(args).toContain('delete_segments+temp_file');
    expect(args.slice(args.indexOf('-c') + 1)).toContain('copy');
  });
  it('rejects unbounded and malformed seek offsets', () => {
    expect(parseRecordingHlsStart('21.75', 7493)).toBe(21.75);
    for (const value of ['-1', 'NaN', '1e9', '8000', ['12']]) {
      expect(parseRecordingHlsStart(value, 7493)).toBeNull();
    }
    expect(parseRecordingHlsStart(undefined, 7493)).toBe(0);
  });
});
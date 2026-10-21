import { describe, expect, it, vi } from 'vitest';
import { buildRecordingHlsArgs, findRecordingHlsCut, parseRecordingHlsStart } from './recording-hls';

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
  it('trims both streams at the decode time of the last keyframe before the start', async () => {
    const probe = vi.fn(async (args: string[]) => args.includes('format=start_time')
      ? JSON.stringify({ format: { start_time: '1.415000' } })
      : JSON.stringify({ packets: [
        { pts_time: '998.830000', dts_time: '998.763000', flags: 'K__' },
        { pts_time: '1000.899000', dts_time: '1000.832000', flags: 'K__' },
        { pts_time: '1000.999000', dts_time: '1000.966000', flags: '___' },
        { pts_time: '1002.930000', dts_time: '1002.863000', flags: 'K__' },
      ] }));
    const cut = await findRecordingHlsCut('/recordings/r1.ts', 1000, probe);
    expect(probe.mock.calls[1][0]).toContain('989.415%1001.915');
    // Keyframe DTS 1000.832 is 999.417 into the file; demux 5 s earlier.
    expect(cut).toEqual({ input: 994.417, output: 4.999 });
    const args = buildRecordingHlsArgs('/recordings/r1.ts', '/cache/index.m3u8', 1000, cut);
    expect(args.slice(0, args.indexOf('-i'))).toContain('994.417');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-c'))).toEqual(
      ['-i', '/recordings/r1.ts', '-ss', '4.999', '-map', '0:v:0', '-map', '0:a:0?']);
  });
  it('falls back to a plain seek without a usable keyframe', async () => {
    const probe = vi.fn(async (args: string[]) => args.includes('format=start_time')
      ? JSON.stringify({ format: { start_time: '0' } })
      : JSON.stringify({ packets: [{ pts_time: '30.5', dts_time: '30.4', flags: '___' }] }));
    expect(await findRecordingHlsCut('/r.ts', 30, probe)).toBeNull();
    expect(await findRecordingHlsCut('/r.ts', 0, probe)).toBeNull();
    const args = buildRecordingHlsArgs('/r.ts', '/cache/index.m3u8', 30, null);
    expect(args.filter(arg => arg === '-ss')).toHaveLength(1);
  });
});

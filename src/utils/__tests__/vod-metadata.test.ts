import { describe, expect, it } from 'vitest';
import { isVodInfoLoading, parseMediaDuration, parseVodId } from '../vod-metadata';

describe('VOD metadata', () => {
  it('extracts Xtream VOD IDs from catalogue channel IDs', () => {
    expect(parseVodId('vod_83608')).toBe(83608);
    expect(parseVodId('movie_42')).toBe(42);
    expect(parseVodId('1m9dt3')).toBeNull();
  });

  it('converts provider duration text to seconds', () => {
    expect(parseMediaDuration('01:30:00')).toBe(5_400);
    expect(parseMediaDuration('90 min')).toBe(5_400);
    expect(parseMediaDuration('')).toBeUndefined();
  });

  it('does not leave manual-M3U movies in a permanent metadata loading state', () => {
    expect(isVodInfoLoading(null, true)).toBe(false);
    expect(isVodInfoLoading(83608, true)).toBe(true);
  });
});

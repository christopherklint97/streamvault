import { describe, expect, it } from 'vitest';
import { getAbsoluteSkipTarget, getHtml5WatchProgress } from '../media-progress';

describe('getHtml5WatchProgress', () => {
  it('adds the restarted HLS offset and keeps the catalogue duration', () => {
    expect(getHtml5WatchProgress(12, Number.POSITIVE_INFINITY, 120, 600)).toEqual({
      position: 132,
      duration: 600,
    });
  });

  it('calculates skip controls from the absolute restarted-stream position', () => {
    expect(getAbsoluteSkipTarget(30, 10, 100, 120, 600)).toBe(160);
  });
});

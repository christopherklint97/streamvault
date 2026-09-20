// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseComskipEdl, validateCommercialIntervals } from './commercial-intervals.js';

describe('Comskip EDL parsing and interval validation', () => {
  it('parses pinned EDL start/end columns and marks detector output suggested', () => {
    expect(parseComskipEdl('10.5\t40.25\t0\n60 90 3\n')).toEqual([
      { startSeconds: 10.5, endSeconds: 40.25, detector: 'comskip', confidence: null, reviewState: 'suggested' },
      { startSeconds: 60, endSeconds: 90, detector: 'comskip', confidence: null, reviewState: 'suggested' },
    ]);
  });

  it('rejects malformed EDL boundaries before they reach persistence', () => {
    expect(() => parseComskipEdl('not-a-time 20 0')).toThrow(/line 1/i);
    expect(() => parseComskipEdl('20 Infinity 0')).toThrow(/line 1/i);
  });

  it('rejects non-finite, negative, reversed, out-of-duration, and overlapping intervals', () => {
    expect(() => validateCommercialIntervals([{ startSeconds: Number.NaN, endSeconds: 2 }], 100)).toThrow(/finite/);
    expect(() => validateCommercialIntervals([{ startSeconds: -1, endSeconds: 2 }], 100)).toThrow(/nonnegative/);
    expect(() => validateCommercialIntervals([{ startSeconds: 2, endSeconds: 2 }], 100)).toThrow(/greater/);
    expect(() => validateCommercialIntervals([{ startSeconds: 2, endSeconds: 101 }], 100)).toThrow(/duration/);
    expect(() => validateCommercialIntervals([
      { startSeconds: 1, endSeconds: 10 }, { startSeconds: 9, endSeconds: 11 },
    ], 100)).toThrow(/overlap/);
  });

  it('sorts valid touching intervals without treating them as overlapping', () => {
    expect(validateCommercialIntervals([
      { startSeconds: 10, endSeconds: 20 }, { startSeconds: 0, endSeconds: 10 },
    ], 20)).toEqual([
      { startSeconds: 0, endSeconds: 10 }, { startSeconds: 10, endSeconds: 20 },
    ]);
  });
});

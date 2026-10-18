import { describe, expect, it } from 'vitest';
import { describeBuffered, liveGapJumpTarget } from './live-gap';

const ranges = (...pairs: [number, number][]) => ({
  length: pairs.length, start: (i: number) => pairs[i][0], end: (i: number) => pairs[i][1],
});

describe('liveGapJumpTarget', () => {
  it('jumps to the next buffered range across a discontinuity gap', () => {
    expect(liveGapJumpTarget(ranges([0, 40], [41.5, 70]), 40)).toBeCloseTo(41.6);
  });
  it('nudges forward when stuck inside a range with media ahead', () => {
    expect(liveGapJumpTarget(ranges([0, 70]), 40)).toBeCloseTo(40.1);
  });
  it('does nothing when the buffer is genuinely exhausted or the gap is too far', () => {
    expect(liveGapJumpTarget(ranges([0, 40.5]), 40)).toBeNull();
    expect(liveGapJumpTarget(ranges([0, 40], [60, 70]), 40)).toBeNull();
    expect(liveGapJumpTarget(ranges(), 40)).toBeNull();
  });
  it('describes ranges for diagnostics', () => {
    expect(describeBuffered(ranges([0, 40], [41.5, 70]))).toBe('0.0-40.0,41.5-70.0');
    expect(describeBuffered(ranges())).toBe('none');
  });
});

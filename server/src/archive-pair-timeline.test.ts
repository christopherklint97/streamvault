import { describe, expect, it } from 'vitest';
import { planVerifiedPairTimeline } from './archive-pair-timeline.js';

const f1 = [
  { id: 's-chunk-000000000.ts', start: 1790928596674, end: 1790928617794, duration: 21.12, epoch: 1 },
  { id: 's-chunk-000000001.ts', start: 1790928609406, end: 1790928628606, duration: 19.2, epoch: 1 },
  { id: 's-chunk-000000002.ts', start: 1790928629494, end: 1790928650614, duration: 21.12, epoch: 1 },
  { id: 's-chunk-000000003.ts', start: 1790928651734, end: 1790928664954, duration: 13.22, epoch: 1 },
];
const espn = [
  { id: 'e-chunk-000000000.ts', start: 1790939995502, end: 1790940016223, duration: 20.7207, epoch: 2 },
  { id: 'e-chunk-000000001.ts', start: 1790940018850, end: 1790940038870, duration: 20.02, epoch: 2 },
  { id: 'e-chunk-000000002.ts', start: 1790940036918, end: 1790940056938, duration: 20.02, epoch: 2 },
  { id: 'e-chunk-000000003.ts', start: 1790940058208, end: 1790940064314, duration: 6.1061, epoch: 2 },
];
describe('verified successor-session presentation clock', () => {
  it('uses media continuity instead of a constant mtime offset for F1 and ESPN', () => {
    const f = planVerifiedPairTimeline(1790928588986, 13.44, 13.44, f1, [true, true, true]);
    expect(f).toEqual([1790928602426, 1790928610106, 1790928629306, 1790928650426]);
    const e = planVerifiedPairTimeline(1790939987757, 14.781433, 4.771433, espn, [true, true, true]);
    expect(e?.[0]).toBeCloseTo(1790940002538.433, 3);
    expect(e?.[1]).toBeCloseTo(1790940018487.7002, 3);
    expect(e?.[2]).toBeCloseTo(1790940038507.7002, 3);
    expect(e?.[3]).toBeCloseTo(1790940058527.7002, 3);
  });
  it('fails closed on missing verification, epoch change, out-of-order chunks or a session longer than the cap', () => {
    expect(planVerifiedPairTimeline(0, 14, 5, f1, [true, false, true])).toBeUndefined();
    expect(planVerifiedPairTimeline(0, 14, 5, [f1[0], { ...f1[1], epoch: 2 }], [true])).toBeUndefined();
    expect(planVerifiedPairTimeline(0, 14, 5, [f1[0], f1[2]], [true])).toBeUndefined();
    expect(planVerifiedPairTimeline(0, 14, 5, Array.from({ length: 15 }, (_, i) =>
      ({ ...f1[0], id: `s-chunk-${String(i).padStart(9, '0')}.ts` })), Array(14).fill(true))).toBeUndefined();
  });
});

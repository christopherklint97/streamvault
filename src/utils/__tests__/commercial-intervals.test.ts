import { describe, expect, it } from 'vitest';
import { prepareCommercialSegments, validateCommercialSegments } from '../commercial-intervals';
import type { CommercialSegment } from '../../types';

function segment(id: string, startSeconds: number, endSeconds: number, state: CommercialSegment['state'] = 'accepted'): CommercialSegment {
  return { id, startSeconds, endSeconds, source: 'manual', confidence: 1, state };
}

describe('commercial interval validation', () => {
  it('requires finite non-negative ordered boundaries within the recording duration', () => {
    const errors = validateCommercialSegments([
      segment('nan', Number.NaN, 4),
      segment('negative', -1, 2),
      segment('backwards', 8, 7),
      segment('long', 9, 11),
    ], 10);

    expect(errors).toEqual([
      'Interval 1 must use finite start and end times.',
      'Interval 2 must start at or after 0.',
      'Interval 3 must end after it starts.',
      'Interval 4 must end within the 0:10 recording duration.',
    ]);
  });

  it('requires intervals to be sorted and non-overlapping', () => {
    expect(validateCommercialSegments([
      segment('later', 20, 30),
      segment('earlier', 10, 25),
    ], 60)).toEqual([
      'Intervals must be sorted by start time.',
      'Intervals must not overlap.',
    ]);
  });

  it('sorts a valid save payload without mutating the draft', () => {
    const draft = [segment('two', 20, 30), segment('one', 5, 10, 'rejected')];
    const prepared = prepareCommercialSegments(draft, 60);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.segments.map((item) => item.id)).toEqual(['one', 'two']);
    expect(draft.map((item) => item.id)).toEqual(['two', 'one']);
  });

  it('rejects overlapping intervals even when sorting would hide the draft ordering issue', () => {
    const prepared = prepareCommercialSegments([
      segment('two', 20, 30),
      segment('one', 10, 25),
    ], 60);

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.errors).toContain('Intervals must not overlap.');
  });
});

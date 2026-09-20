import { describe, expect, it } from 'vitest';
import { getCommercialMarkers } from './commercial-markers';
import type { CommercialSegment } from '../types';

function segment(
  id: string,
  startSeconds: number,
  endSeconds: number,
  state: CommercialSegment['state'] = 'accepted',
): CommercialSegment {
  return { id, startSeconds, endSeconds, state, source: 'manual', confidence: 1 };
}

describe('commercial seek-bar markers', () => {
  it('maps only accepted finite intervals onto the recording timeline', () => {
    expect(getCommercialMarkers([
      segment('first', 10, 20),
      segment('suggested', 30, 40, 'suggested'),
      segment('bad', Number.NaN, 50),
      segment('last', 90, 110),
    ], 100)).toEqual([
      { id: 'first', leftPercent: 10, widthPercent: 10 },
      { id: 'last', leftPercent: 90, widthPercent: 10 },
    ]);
  });

  it('returns no markers without a finite positive duration', () => {
    expect(getCommercialMarkers([segment('first', 10, 20)], 0)).toEqual([]);
  });
});

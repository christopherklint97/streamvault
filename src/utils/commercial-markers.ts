import type { CommercialSegment } from '../types';

export interface CommercialMarker {
  id: string;
  leftPercent: number;
  widthPercent: number;
}

export function getCommercialMarkers(
  segments: readonly CommercialSegment[],
  duration: number,
): CommercialMarker[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return segments.flatMap((segment) => {
    if (
      segment.state !== 'accepted'
      || !Number.isFinite(segment.startSeconds)
      || !Number.isFinite(segment.endSeconds)
      || segment.startSeconds < 0
      || segment.endSeconds <= segment.startSeconds
      || segment.startSeconds >= duration
    ) return [];
    const start = Math.min(segment.startSeconds, duration);
    const end = Math.min(segment.endSeconds, duration);
    return [{
      id: segment.id,
      leftPercent: (start / duration) * 100,
      widthPercent: ((end - start) / duration) * 100,
    }];
  });
}

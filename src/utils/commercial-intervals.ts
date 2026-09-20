import type { CommercialSegment } from '../types';

export type PreparedCommercialSegments =
  | { ok: true; segments: CommercialSegment[] }
  | { ok: false; errors: string[] };

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function validateCommercialSegments(
  segments: readonly CommercialSegment[],
  duration: number,
): string[] {
  const errors: string[] = [];
  const hasDuration = Number.isFinite(duration) && duration > 0;

  segments.forEach((segment, index) => {
    const label = `Interval ${index + 1}`;
    if (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)) {
      errors.push(`${label} must use finite start and end times.`);
      return;
    }
    if (segment.startSeconds < 0) {
      errors.push(`${label} must start at or after 0.`);
      return;
    }
    if (segment.endSeconds <= segment.startSeconds) {
      errors.push(`${label} must end after it starts.`);
      return;
    }
    if (hasDuration && segment.endSeconds > duration) {
      errors.push(`${label} must end within the ${formatDuration(duration)} recording duration.`);
    }
  });

  let unsorted = false;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].startSeconds) {
      unsorted = true;
      break;
    }
  }
  if (unsorted) errors.push('Intervals must be sorted by start time.');

  const sorted = [...segments].sort((left, right) =>
    left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      Number.isFinite(previous.endSeconds)
      && Number.isFinite(current.startSeconds)
      && current.startSeconds < previous.endSeconds
    ) {
      errors.push('Intervals must not overlap.');
      break;
    }
  }

  return errors;
}

export function prepareCommercialSegments(
  segments: readonly CommercialSegment[],
  duration: number,
): PreparedCommercialSegments {
  const sorted = segments
    .map((segment) => ({ ...segment }))
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const errors = validateCommercialSegments(sorted, duration).filter(
    (error) => error !== 'Intervals must be sorted by start time.',
  );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, segments: sorted };
}

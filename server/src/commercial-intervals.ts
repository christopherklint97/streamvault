export interface CommercialIntervalInput {
  startSeconds: number;
  endSeconds: number;
}

export interface DetectedCommercialInterval extends CommercialIntervalInput {
  detector: 'comskip';
  confidence: null;
  reviewState: 'suggested';
}

export function parseComskipEdl(content: string): DetectedCommercialInterval[] {
  const intervals: DetectedCommercialInterval[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 2) throw new Error(`Invalid Comskip EDL line ${index + 1}`);
    const startSeconds = Number(columns[0]);
    const endSeconds = Number(columns[1]);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      throw new Error(`Invalid Comskip EDL line ${index + 1}`);
    }
    intervals.push({ startSeconds, endSeconds, detector: 'comskip', confidence: null, reviewState: 'suggested' });
  }
  return intervals;
}

export function validateCommercialIntervals<T extends CommercialIntervalInput>(
  intervals: T[],
  durationSeconds: number,
): T[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('Recording duration must be finite and nonnegative');
  const sorted = [...intervals].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  let previousEnd = 0;
  for (const [index, interval] of sorted.entries()) {
    if (!Number.isFinite(interval.startSeconds) || !Number.isFinite(interval.endSeconds)) {
      throw new Error(`Commercial interval ${index} boundaries must be finite`);
    }
    if (interval.startSeconds < 0 || interval.endSeconds < 0) {
      throw new Error(`Commercial interval ${index} boundaries must be nonnegative`);
    }
    if (interval.endSeconds <= interval.startSeconds) {
      throw new Error(`Commercial interval ${index} end must be greater than start`);
    }
    if (interval.endSeconds > durationSeconds) {
      throw new Error(`Commercial interval ${index} exceeds recording duration`);
    }
    if (index > 0 && interval.startSeconds < previousEnd) {
      throw new Error(`Commercial intervals overlap at index ${index}`);
    }
    previousEnd = interval.endSeconds;
  }
  return sorted;
}

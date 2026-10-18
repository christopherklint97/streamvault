/** Minimal TimeRanges shape so the policy is testable without a media element. */
export type BufferedRanges = Pick<TimeRanges, 'length' | 'start' | 'end'>;

// A provider reconnect publishes EXT-X-DISCONTINUITY. Old native players
// (iOS 12) can stop at that seam with media buffered just past it; stepping
// over the seam is far cheaper than a full reauthorize/restart.
const MAX_GAP_SECONDS = 10;
const NUDGE_SECONDS = 0.1;

/** Position that resumes a stuck native live player, or null if none is buffered. */
export function liveGapJumpTarget(buffered: BufferedRanges, currentTime: number): number | null {
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    // Stuck inside a range that still has media ahead: nudge past the seam.
    if (start <= currentTime && end - currentTime > 1) return currentTime + NUDGE_SECONDS;
    if (start > currentTime && start - currentTime <= MAX_GAP_SECONDS) return start + NUDGE_SECONDS;
  }
  return null;
}

export function describeBuffered(buffered: BufferedRanges): string {
  const ranges: string[] = [];
  for (let i = 0; i < buffered.length; i++) ranges.push(`${buffered.start(i).toFixed(1)}-${buffered.end(i).toFixed(1)}`);
  return ranges.join(',') || 'none';
}

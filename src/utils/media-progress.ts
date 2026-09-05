export interface Html5WatchProgress {
  position: number;
  duration: number;
}

export function getResumePosition(progress: { position: number; completed?: boolean } | null): number {
  if (!progress || progress.completed || !Number.isFinite(progress.position) || progress.position <= 0) return 0;
  return progress.position;
}

export function getAbsoluteSkipTarget(
  currentTime: number,
  delta: number,
  mediaDuration: number,
  streamOffset = 0,
  catalogueDuration?: number,
): number {
  const offset = Number.isFinite(streamOffset) && streamOffset > 0 ? streamOffset : 0;
  const target = offset + (Number.isFinite(currentTime) ? currentTime : 0) + delta;
  const maximum = Number.isFinite(catalogueDuration) && (catalogueDuration ?? 0) > 0
    ? catalogueDuration!
    : Number.isFinite(mediaDuration) && mediaDuration > 0
      ? offset + mediaDuration
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(maximum, target));
}

/** Convert a restarted media timeline into absolute catalogue progress. */
export function getHtml5WatchProgress(
  currentTime: number,
  mediaDuration: number,
  streamOffset = 0,
  catalogueDuration?: number,
): Html5WatchProgress | null {
  if (!Number.isFinite(currentTime) || currentTime < 0) return null;
  const offset = Number.isFinite(streamOffset) && streamOffset > 0 ? streamOffset : 0;
  const position = offset + currentTime;
  if (position <= 0) return null;

  const duration = Number.isFinite(catalogueDuration) && (catalogueDuration ?? 0) > 0
    ? catalogueDuration!
    : Number.isFinite(mediaDuration) && mediaDuration > 0
      ? offset + mediaDuration
      : 0;
  return { position, duration };
}

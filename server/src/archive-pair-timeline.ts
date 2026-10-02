export type TimelineChunk = {
  id: string; start: number; end: number; duration: number; epoch: number;
};

/** Assign a finite VOD presentation clock only to an already-closed, bounded
 * successor session whose every adjacent TS handoff was independently verified.
 * File mtimes can wander by seconds even though the captured media is continuous. */
export function planVerifiedPairTimeline(priorStart: number, priorCut: number,
  nextOffset: number, session: TimelineChunk[], verifiedEdges: boolean[]): number[] | undefined {
  if (!Number.isFinite(priorStart) || !Number.isFinite(priorCut) || !Number.isFinite(nextOffset) ||
      priorCut <= 0 || nextOffset < 0 || session.length < 2 || session.length > 14 ||
      verifiedEdges.length !== session.length - 1 || verifiedEdges.some(ok => !ok) ||
      nextOffset >= session[0].duration) return undefined;
  const first = /^(.*)-chunk-000000000\.ts$/.exec(session[0].id);
  if (!first) return undefined;
  const starts = [priorStart + priorCut * 1000];
  for (let i = 0; i < session.length; i++) {
    const row = session[i];
    if (row.id !== `${first[1]}-chunk-${String(i).padStart(9, '0')}.ts` ||
        row.epoch !== session[0].epoch || !Number.isFinite(row.duration) ||
        row.duration <= 0 || row.duration > 120 || !Number.isFinite(row.start) ||
        !Number.isFinite(row.end) || row.end <= row.start) return undefined;
    if (i) starts.push(starts[i - 1] +
      (session[i - 1].duration - (i === 1 ? nextOffset : 0)) * 1000);
  }
  return starts.every(Number.isFinite) ? starts : undefined;
}

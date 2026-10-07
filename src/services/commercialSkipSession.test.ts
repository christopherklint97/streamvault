import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommercialSkipSession } from './commercialSkipSession';
import type { CommercialSegment, CommercialSegmentsResponse } from '../types';

function accepted(id: string, startSeconds: number, endSeconds: number, source: CommercialSegment['source'] = 'detector'): CommercialSegment {
  return { id, startSeconds, endSeconds, source, confidence: 0.9, state: 'accepted' };
}

function response(segments: CommercialSegment[], effectiveAutoSkip = true): CommercialSegmentsResponse {
  return {
    analysis: { status: 'ready', error: null, detector: 'test', profileVersion: '1' },
    segments,
    autoSkipOverride: null,
    effectiveAutoSkip,
  };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('CommercialSkipSession', () => {
  beforeEach(() => vi.useRealTimers());

  it('only triggers accepted intervals at start-inclusive/end-exclusive boundaries', async () => {
    const seek = vi.fn(async () => {});
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({
      recordingId: 'r1', duration: 100, enabled: true, seek,
      segments: [
        { ...accepted('suggested', 2, 4), state: 'suggested' },
        { ...accepted('rejected', 5, 7), state: 'rejected' },
        accepted('manual', 10, 20, 'manual'),
      ],
    });

    session.tick(9.999, generation);
    session.tick(20, generation);
    expect(seek).not.toHaveBeenCalled();

    session.tick(10, generation);
    await flush();
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(20, expect.any(AbortSignal));
  });

  it('filters invalid and overlapping accepted intervals and clamps an end to duration', async () => {
    const seek = vi.fn(async () => {});
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({
      recordingId: 'r1', duration: 100, enabled: true, seek,
      segments: [
        accepted('negative', -1, 2),
        accepted('backwards', 8, 7),
        accepted('first', 10, 20),
        accepted('overlap', 15, 25),
        accepted('clamped', 90, 110),
        accepted('past-end', 100, 120),
      ],
    });

    expect(session.getSnapshot().segments.map((item) => [item.id, item.startSeconds, item.endSeconds])).toEqual([
      ['first', 10, 20],
      ['clamped', 90, 100],
    ]);

    session.tick(95, generation);
    await flush();
    expect(seek).toHaveBeenCalledWith(100, expect.any(AbortSignal));
  });

  it('marks an interval handled before seeking so duplicate ticks cannot duplicate a pending seek', async () => {
    let finish!: () => void;
    const seek = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({ recordingId: 'r1', duration: 60, enabled: true, seek, segments: [accepted('ad', 10, 20)] });

    session.tick(10, generation);
    session.tick(11, generation);
    expect(seek).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(session.getSnapshot().undo?.originalPosition).toBe(10);
  });

  it('clears handled state after a failed seek so a later tick retries without showing Undo', async () => {
    const seek = vi.fn()
      .mockRejectedValueOnce(new Error('seek failed'))
      .mockResolvedValueOnce(undefined);
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({ recordingId: 'r1', duration: 60, enabled: true, seek, segments: [accepted('ad', 10, 20)] });

    session.tick(10, generation);
    await flush();
    expect(session.getSnapshot().undo).toBeNull();

    session.tick(11, generation);
    await flush();
    expect(seek).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().undo?.segmentId).toBe('ad');
  });

  it('Undo returns to the pre-skip position and suppresses that interval for the playback session', async () => {
    const seek = vi.fn(async () => {});
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({ recordingId: 'r1', duration: 60, enabled: true, seek, segments: [accepted('ad', 10, 20)] });

    session.tick(12, generation);
    await flush();
    await session.undo();
    expect(seek).toHaveBeenLastCalledWith(12, expect.any(AbortSignal));
    expect(session.getSnapshot().undo).toBeNull();

    session.tick(13, generation);
    await flush();
    expect(seek).toHaveBeenCalledTimes(2);
  });

  it('aborts a pending Undo seek when the viewer seeks manually', async () => {
    let undoSignal: AbortSignal | undefined;
    const seek = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce((_target: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
        undoSignal = signal;
        if (!signal) {
          reject(new Error('Undo seek did not receive an AbortSignal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({
      recordingId: 'r1', duration: 60, enabled: true, seek, segments: [accepted('ad', 10, 20)],
    });

    session.tick(12, generation);
    await flush();
    const undoResult = session.undo();
    await flush();
    expect(undoSignal?.aborted).toBe(false);

    session.noteManualSeek();

    expect(undoSignal?.aborted).toBe(true);
    await expect(undoResult).resolves.toBe(false);
    expect(session.getSnapshot().undo).toBeNull();
  });

  it('expires Undo independently after nine seconds', async () => {
    vi.useFakeTimers();
    const session = new CommercialSkipSession({ undoWindowMs: 9_000 });
    const generation = session.beginPlayback({ recordingId: 'r1', duration: 60, enabled: true, seek: async () => {}, segments: [accepted('ad', 10, 20)] });

    session.tick(10, generation);
    await flush();
    expect(session.getSnapshot().undo).not.toBeNull();
    vi.advanceTimersByTime(9_000);
    expect(session.getSnapshot().undo).toBeNull();
  });

  it('ignores stale ticks and stale seek completion after playback generation changes', async () => {
    let finishOld!: () => void;
    const oldSeek = vi.fn(() => new Promise<void>((resolve) => { finishOld = resolve; }));
    const session = new CommercialSkipSession();
    const oldGeneration = session.beginPlayback({ recordingId: 'old', duration: 60, enabled: true, seek: oldSeek, segments: [accepted('old-ad', 10, 20)] });
    session.tick(10, oldGeneration);

    const newSeek = vi.fn(async () => {});
    const newGeneration = session.beginPlayback({ recordingId: 'new', duration: 60, enabled: true, seek: newSeek, segments: [accepted('new-ad', 30, 40)] });
    session.tick(12, oldGeneration);
    finishOld();
    await flush();

    expect(session.getSnapshot().recordingId).toBe('new');
    expect(session.getSnapshot().undo).toBeNull();
    session.tick(30, newGeneration);
    await flush();
    expect(newSeek).toHaveBeenCalledWith(40, expect.any(AbortSignal));
  });

  it('aborts a pending automatic seek when the viewer seeks manually', async () => {
    let finishAuto!: () => void;
    let automaticSignal: AbortSignal | undefined;
    const seek = vi.fn((_target: number, signal?: AbortSignal) => {
      automaticSignal = signal;
      return new Promise<void>((resolve) => { finishAuto = resolve; });
    });
    const session = new CommercialSkipSession();
    const generation = session.beginPlayback({
      recordingId: 'r1', duration: 60, enabled: true, seek, segments: [accepted('ad', 10, 20)],
    });

    session.tick(10, generation);
    expect(session.getSnapshot().seekPending).toBe(true);
    expect(automaticSignal?.aborted).toBe(false);
    session.noteManualSeek();
    expect(automaticSignal?.aborted).toBe(true);
    expect(session.getSnapshot().seekPending).toBe(false);

    finishAuto();
    await flush();
    expect(session.getSnapshot().undo).toBeNull();
  });

  it('generation-guards asynchronous metadata fetches and degrades to unavailable without throwing', async () => {
    let resolveOld!: (value: CommercialSegmentsResponse) => void;
    const oldFetch = () => new Promise<CommercialSegmentsResponse>((resolve) => { resolveOld = resolve; });
    const session = new CommercialSkipSession();
    session.loadPlayback({ recordingId: 'old', duration: 60, fetchMetadata: oldFetch, seek: async () => {} });
    session.loadPlayback({ recordingId: 'new', duration: 60, fetchMetadata: async () => response([accepted('new-ad', 3, 5)]), seek: async () => {} });
    await flush();
    resolveOld(response([accepted('old-ad', 1, 2)]));
    await flush();

    expect(session.getSnapshot().recordingId).toBe('new');
    expect(session.getSnapshot().segments.map((item) => item.id)).toEqual(['new-ad']);

    session.loadPlayback({ recordingId: 'broken', duration: 60, fetchMetadata: async () => { throw new Error('offline'); }, seek: async () => {} });
    await flush();
    expect(session.getSnapshot().phase).toBe('unavailable');
    expect(session.getSnapshot().enabled).toBe(false);
  });
});

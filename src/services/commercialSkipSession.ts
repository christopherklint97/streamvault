import type { CommercialSegment, CommercialSegmentsResponse } from '../types';

export type CommercialSkipPhase = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface CommercialSkipUndo {
  segmentId: string;
  originalPosition: number;
  targetPosition: number;
  expiresAt: number;
}

export interface CommercialSkipSnapshot {
  recordingId: string | null;
  generation: number;
  phase: CommercialSkipPhase;
  enabled: boolean;
  segments: CommercialSegment[];
  seekPending: boolean;
  undo: CommercialSkipUndo | null;
}

interface PlaybackConfig {
  recordingId: string;
  duration: number;
  enabled: boolean;
  segments: readonly CommercialSegment[];
  seek: (targetSeconds: number, signal?: AbortSignal) => Promise<void>;
}

interface LoadingConfig {
  recordingId: string;
  duration: number;
  fetchMetadata: () => Promise<CommercialSegmentsResponse>;
  seek: (targetSeconds: number, signal?: AbortSignal) => Promise<void>;
}

interface SessionOptions {
  undoWindowMs?: number;
}

function normalizeSegments(
  segments: readonly CommercialSegment[],
  duration: number,
): CommercialSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const eligible = segments
    .filter((segment) => segment.state === 'accepted')
    .filter((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds))
    .filter((segment) => segment.startSeconds >= 0 && segment.startSeconds < duration)
    .map((segment) => ({ ...segment, endSeconds: Math.min(segment.endSeconds, duration) }))
    .filter((segment) => segment.endSeconds > segment.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);

  const result: CommercialSegment[] = [];
  for (const segment of eligible) {
    const previous = result[result.length - 1];
    if (previous && segment.startSeconds < previous.endSeconds) continue;
    result.push(segment);
  }
  return result;
}

export class CommercialSkipSession {
  private readonly undoWindowMs: number;
  private generation = 0;
  private duration = 0;
  private seek: ((targetSeconds: number, signal?: AbortSignal) => Promise<void>) | null = null;
  private handled = new Set<string>();
  private suppressed = new Set<string>();
  private seekIntent = 0;
  private activeSeekController: AbortController | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CommercialSkipSnapshot = {
    recordingId: null,
    generation: 0,
    phase: 'idle',
    enabled: false,
    segments: [],
    seekPending: false,
    undo: null,
  };

  constructor(options: SessionOptions = {}) {
    this.undoWindowMs = options.undoWindowMs ?? 9_000;
  }

  getSnapshot = (): CommercialSkipSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(next: Partial<CommercialSkipSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private clearUndoTimer(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
  }

  private initialize(
    recordingId: string,
    duration: number,
    seek: (targetSeconds: number, signal?: AbortSignal) => Promise<void>,
  ): number {
    this.clearUndoTimer();
    this.activeSeekController?.abort();
    this.activeSeekController = null;
    this.generation += 1;
    this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.seek = seek;
    this.handled = new Set();
    this.suppressed = new Set();
    this.seekIntent = 0;
    this.emit({
      recordingId,
      generation: this.generation,
      phase: 'loading',
      enabled: false,
      segments: [],
      seekPending: false,
      undo: null,
    });
    return this.generation;
  }

  beginPlayback(config: PlaybackConfig): number {
    const generation = this.initialize(config.recordingId, config.duration, config.seek);
    this.emit({
      phase: 'ready',
      enabled: config.enabled,
      segments: normalizeSegments(config.segments, this.duration),
    });
    return generation;
  }

  loadPlayback(config: LoadingConfig): number {
    const generation = this.initialize(config.recordingId, config.duration, config.seek);
    void config.fetchMetadata().then((metadata) => {
      if (generation !== this.generation || config.recordingId !== this.snapshot.recordingId) return;
      this.emit({
        phase: 'ready',
        enabled: metadata.effectiveAutoSkip,
        segments: normalizeSegments(metadata.segments, this.duration),
      });
    }).catch(() => {
      if (generation !== this.generation || config.recordingId !== this.snapshot.recordingId) return;
      this.emit({ phase: 'unavailable', enabled: false, segments: [] });
    });
    return generation;
  }

  reset(): number {
    this.clearUndoTimer();
    this.activeSeekController?.abort();
    this.activeSeekController = null;
    this.generation += 1;
    this.duration = 0;
    this.seek = null;
    this.handled.clear();
    this.suppressed.clear();
    this.emit({
      recordingId: null,
      generation: this.generation,
      phase: 'idle',
      enabled: false,
      segments: [],
      seekPending: false,
      undo: null,
    });
    return this.generation;
  }

  tick(positionSeconds: number, generation = this.generation): void {
    if (
      generation !== this.generation
      || this.snapshot.phase !== 'ready'
      || !this.snapshot.enabled
      || this.snapshot.seekPending
      || !Number.isFinite(positionSeconds)
      || !this.seek
    ) return;

    const segment = this.snapshot.segments.find((candidate) =>
      positionSeconds >= candidate.startSeconds
      && positionSeconds < candidate.endSeconds
      && !this.handled.has(candidate.id)
      && !this.suppressed.has(candidate.id),
    );
    if (!segment) return;

    const target = Math.min(segment.endSeconds, this.duration);
    const seek = this.seek;
    const seekIntent = ++this.seekIntent;
    const seekController = new AbortController();
    this.activeSeekController?.abort();
    this.activeSeekController = seekController;
    this.handled.add(segment.id);
    this.emit({ seekPending: true });
    void seek(target, seekController.signal).then(() => {
      if (generation !== this.generation || seekIntent !== this.seekIntent) return;
      if (this.activeSeekController === seekController) this.activeSeekController = null;
      const undo: CommercialSkipUndo = {
        segmentId: segment.id,
        originalPosition: positionSeconds,
        targetPosition: target,
        expiresAt: Date.now() + this.undoWindowMs,
      };
      this.clearUndoTimer();
      this.emit({ seekPending: false, undo });
      this.undoTimer = setTimeout(() => {
        if (generation === this.generation && this.snapshot.undo?.segmentId === segment.id) {
          this.emit({ undo: null });
        }
      }, this.undoWindowMs);
    }).catch(() => {
      if (generation !== this.generation || seekIntent !== this.seekIntent) return;
      if (this.activeSeekController === seekController) this.activeSeekController = null;
      this.handled.delete(segment.id);
      this.emit({ seekPending: false, undo: null });
    });
  }

  noteManualSeek(): void {
    this.seekIntent += 1;
    this.activeSeekController?.abort();
    this.activeSeekController = null;
    this.clearUndoTimer();
    this.emit({ seekPending: false, undo: null });
  }

  async undo(): Promise<boolean> {
    const undo = this.snapshot.undo;
    const seek = this.seek;
    const generation = this.generation;
    if (!undo || !seek) return false;

    const seekIntent = ++this.seekIntent;
    const seekController = new AbortController();
    this.activeSeekController?.abort();
    this.activeSeekController = seekController;
    this.suppressed.add(undo.segmentId);
    try {
      await seek(
        Math.max(0, Math.min(undo.originalPosition, this.duration)),
        seekController.signal,
      );
      if (
        generation !== this.generation
        || seekIntent !== this.seekIntent
        || seekController.signal.aborted
      ) return false;
      if (this.activeSeekController === seekController) this.activeSeekController = null;
      this.clearUndoTimer();
      this.emit({ undo: null });
      return true;
    } catch {
      if (generation === this.generation && seekIntent === this.seekIntent) {
        this.suppressed.delete(undo.segmentId);
        if (this.activeSeekController === seekController) this.activeSeekController = null;
      }
      return false;
    }
  }
}

/** One playback-scoped session shared across Player component mount cycles. */
export const commercialSkipSession = new CommercialSkipSession();

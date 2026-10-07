export interface PlaybackClockReading {
  position: number;
  duration: number;
}

export interface PlaybackClockSnapshot extends PlaybackClockReading {
  generation: number;
}

interface CommercialClockTarget {
  tick(positionSeconds: number, generation?: number): void;
}

function positiveFinite(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function nonNegativeFinite(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? value! : 0;
}

export function getHtml5ClockReading(
  currentTimeSeconds: number,
  mediaDurationSeconds: number,
  streamOffsetSeconds = 0,
  catalogueDurationSeconds?: number,
): PlaybackClockReading {
  const offset = nonNegativeFinite(streamOffsetSeconds);
  const position = offset + nonNegativeFinite(currentTimeSeconds);
  const catalogueDuration = positiveFinite(catalogueDurationSeconds);
  const mediaDuration = positiveFinite(mediaDurationSeconds);
  const duration = catalogueDuration || (mediaDuration ? offset + mediaDuration : 0);
  return {
    position: duration ? Math.min(position, duration) : position,
    duration,
  };
}

export function getAvPlayClockReading(
  currentTimeMs: number,
  mediaDurationMs: number,
  catalogueDurationSeconds?: number,
): PlaybackClockReading {
  const position = nonNegativeFinite(currentTimeMs) / 1000;
  const catalogueDuration = positiveFinite(catalogueDurationSeconds);
  const mediaDuration = positiveFinite(mediaDurationMs) / 1000;
  const duration = catalogueDuration || mediaDuration;
  return {
    position: duration ? Math.min(position, duration) : position,
    duration,
  };
}

export class PlaybackClock {
  private listeners = new Set<() => void>();
  private snapshot: PlaybackClockSnapshot = { generation: 0, position: 0, duration: 0 };

  getSnapshot = (): PlaybackClockSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  begin(durationHint = 0): number {
    const generation = this.snapshot.generation + 1;
    this.publish({ generation, position: 0, duration: positiveFinite(durationHint) });
    return generation;
  }

  reset(): number {
    return this.begin(0);
  }

  update(reading: PlaybackClockReading, generation: number): boolean {
    if (generation !== this.snapshot.generation) return false;
    const position = nonNegativeFinite(reading.position);
    const duration = positiveFinite(reading.duration);
    if (position === this.snapshot.position && duration === this.snapshot.duration) return true;
    this.publish({ generation, position, duration });
    return true;
  }

  private publish(snapshot: PlaybackClockSnapshot): void {
    if (
      snapshot.generation === this.snapshot.generation
      && snapshot.position === this.snapshot.position
      && snapshot.duration === this.snapshot.duration
    ) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function routePlaybackClock(
  clock: PlaybackClock,
  clockGeneration: number,
  reading: PlaybackClockReading,
  commercialSession?: CommercialClockTarget,
  commercialGeneration?: number,
  startupReady = true,
): boolean {
  if (!startupReady) return false;
  if (!clock.update(reading, clockGeneration)) return false;
  if (commercialSession && commercialGeneration !== undefined) {
    commercialSession.tick(reading.position, commercialGeneration);
  }
  return true;
}

/** Playback-scoped external clock; avoids high-frequency global store updates. */
export const playbackClock = new PlaybackClock();

import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackClock,
  getAvPlayClockReading,
  getHtml5ClockReading,
  routePlaybackClock,
} from './playbackClock';

describe('playback clock routing', () => {
  it('uses the absolute HTML5 media timeline and catalogue duration', () => {
    expect(getHtml5ClockReading(12.5, 40, 30, 120)).toEqual({
      position: 42.5,
      duration: 120,
    });
    expect(getHtml5ClockReading(12.5, 40, 30)).toEqual({
      position: 42.5,
      duration: 70,
    });
  });

  it('converts AVPlay milliseconds to seconds and prefers the catalogue duration', () => {
    expect(getAvPlayClockReading(12_500, 90_000, 120)).toEqual({
      position: 12.5,
      duration: 120,
    });
  });

  it('publishes a stable snapshot and routes accepted generations to commercial skipping', () => {
    const clock = new PlaybackClock();
    const generation = clock.begin(120);
    const tick = vi.fn();
    const reading = getHtml5ClockReading(12.5, 40, 30, 120);

    expect(routePlaybackClock(clock, generation, reading, { tick }, 7)).toBe(true);
    expect(clock.getSnapshot()).toMatchObject({ position: 42.5, duration: 120, generation });
    expect(tick).toHaveBeenCalledWith(42.5, 7);

    const snapshot = clock.getSnapshot();
    expect(routePlaybackClock(clock, generation, reading, { tick }, 7)).toBe(true);
    expect(clock.getSnapshot()).toBe(snapshot);
  });

  it('rejects stale player generations before updating the clock or ticking the session', () => {
    const clock = new PlaybackClock();
    const staleGeneration = clock.begin(60);
    const activeGeneration = clock.begin(90);
    const tick = vi.fn();

    expect(routePlaybackClock(
      clock,
      staleGeneration,
      { position: 20, duration: 60 },
      { tick },
      1,
    )).toBe(false);
    expect(clock.getSnapshot()).toMatchObject({ generation: activeGeneration, position: 0, duration: 90 });
    expect(tick).not.toHaveBeenCalled();
  });

  it('suppresses clock publication and commercial ticks until startup resume is complete', () => {
    const clock = new PlaybackClock();
    const generation = clock.begin(120);
    const tick = vi.fn();

    expect(routePlaybackClock(
      clock,
      generation,
      { position: 0, duration: 120 },
      { tick },
      9,
      false,
    )).toBe(false);
    expect(clock.getSnapshot()).toMatchObject({ position: 0, duration: 120 });
    expect(tick).not.toHaveBeenCalled();

    expect(routePlaybackClock(
      clock,
      generation,
      { position: 47, duration: 120 },
      { tick },
      9,
      true,
    )).toBe(true);
    expect(clock.getSnapshot()).toMatchObject({ position: 47, duration: 120 });
    expect(tick).toHaveBeenCalledWith(47, 9);
  });

  it('resets the public clock when playback stops', () => {
    const clock = new PlaybackClock();
    clock.begin(90);
    clock.reset();
    expect(clock.getSnapshot()).toEqual({ generation: 2, position: 0, duration: 0 });
  });
});

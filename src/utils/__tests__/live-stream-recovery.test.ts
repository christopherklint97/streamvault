import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveStreamRecovery } from '../live-stream-recovery';
import { hasDecodedFrameProgress, withLiveStreamOptions } from '../live-stream-options';

describe('withLiveStreamOptions', () => {
  it('adds audio-only mode while preserving existing query parameters', () => {
    expect(withLiveStreamOptions('/api/stream/live_1015944?subs=1', true)).toBe(
      '/api/stream/live_1015944?subs=1&audio=1',
    );
  });

  it('leaves the stream URL unchanged in normal video mode', () => {
    expect(withLiveStreamOptions('/api/stream/live_1015944', false)).toBe(
      '/api/stream/live_1015944',
    );
  });
});

describe('hasDecodedFrameProgress', () => {
  it('requires decoded frames to increase beyond zero', () => {
    expect(hasDecodedFrameProgress(0, 0)).toBe(false);
    expect(hasDecodedFrameProgress(0, 1)).toBe(true);
    expect(hasDecodedFrameProgress(12, 12)).toBe(false);
    expect(hasDecodedFrameProgress(12, undefined)).toBe(false);
  });
});

describe('LiveStreamRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects a live stream when the transport completes', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, {
      stallTimeoutMs: 10_000,
      retryDelaysMs: [250, 1_000, 3_000],
    });

    recovery.begin('live_1015944');
    recovery.transportEnded('loading-complete');

    vi.advanceTimersByTime(249);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledWith('loading-complete', 1);
  });

  it('ignores transient stalled events while playback keeps progressing', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, { stallTimeoutMs: 10_000 });

    recovery.begin('live_1015944');
    recovery.stalled();
    vi.advanceTimersByTime(7_000);
    recovery.progress();
    vi.advanceTimersByTime(7_000);

    expect(recover).not.toHaveBeenCalled();
  });

  it('reconnects when playback makes no progress for the stall timeout', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, {
      stallTimeoutMs: 10_000,
      retryDelaysMs: [250],
    });

    recovery.begin('live_1015944');
    vi.advanceTimersByTime(10_249);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(recover).toHaveBeenCalledWith('stalled', 1);
  });

  it('cancels a pending stall reconnect when real progress resumes during backoff', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, {
      stallTimeoutMs: 10_000,
      retryDelaysMs: [1_000],
    });

    recovery.begin('live_1015944');
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(500);
    recovery.progress();
    vi.advanceTimersByTime(1_000);

    expect(recover).not.toHaveBeenCalled();
  });

  it('still reconnects after a terminal EOF without treating buffered media as a retry reset', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, { retryDelaysMs: [1_000, 2_000] });

    recovery.begin('live_1015944');
    recovery.transportEnded('loading-complete');
    recovery.progress();
    vi.advanceTimersByTime(1_000);
    expect(recover).toHaveBeenCalledWith('loading-complete', 1);

    recovery.begin('live_1015944');
    recovery.transportEnded('loading-complete');
    vi.advanceTimersByTime(1_999);
    expect(recover).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenLastCalledWith('loading-complete', 2);
  });

  it('backs off repeated failures and resets after real progress', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, {
      stallTimeoutMs: 10_000,
      retryDelaysMs: [250, 1_000, 3_000],
    });

    recovery.begin('live_1015944');
    recovery.transportEnded('mpegts-error');
    vi.advanceTimersByTime(250);
    expect(recover).toHaveBeenLastCalledWith('mpegts-error', 1);

    recovery.begin('live_1015944');
    recovery.transportEnded('media-ended');
    vi.advanceTimersByTime(999);
    expect(recover).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenLastCalledWith('media-ended', 2);

    recovery.begin('live_1015944');
    recovery.progress();
    recovery.transportEnded('loading-complete');
    vi.advanceTimersByTime(250);
    expect(recover).toHaveBeenLastCalledWith('loading-complete', 1);
  });

  it('does not reconnect while playback is intentionally paused', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, {
      stallTimeoutMs: 10_000,
      retryDelaysMs: [250],
    });

    recovery.begin('live_1015944');
    recovery.suspend();
    vi.advanceTimersByTime(60_000);
    expect(recover).not.toHaveBeenCalled();

    recovery.resume();
    vi.advanceTimersByTime(10_250);
    expect(recover).toHaveBeenCalledWith('stalled', 1);
  });

  it('cancels pending recovery when playback is explicitly stopped', () => {
    const recover = vi.fn();
    const recovery = new LiveStreamRecovery(recover, { retryDelaysMs: [250] });

    recovery.begin('live_1015944');
    recovery.transportEnded('loading-complete');
    recovery.stop();
    vi.advanceTimersByTime(1_000);

    expect(recover).not.toHaveBeenCalled();
  });
});

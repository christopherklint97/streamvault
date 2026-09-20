import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getInitialResumeTarget,
  retryPlaybackSeek,
  seekAvPlay,
  seekHtml5,
} from './playbackSeek';

afterEach(() => vi.useRealTimers());

describe('completion-aware playback seek', () => {
  it('clamps stale resume positions to a known prepared-media duration', () => {
    expect(getInitialResumeTarget(999, 120)).toBe(120);
    expect(getInitialResumeTarget(45, 120)).toBe(45);
    expect(getInitialResumeTarget(999, Number.NaN)).toBe(999);
  });

  it('resolves an HTML5 seek only after seeked fires', async () => {
    const video = document.createElement('video');
    const promise = seekHtml5(video, 25, 1_000);
    let complete = false;
    void promise.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(video.currentTime).toBe(25);

    video.dispatchEvent(new Event('seeked'));
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects an HTML5 seek when completion times out', async () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    const promise = seekHtml5(video, 25, 500);
    const assertion = expect(promise).rejects.toThrow('timed out');
    vi.advanceTimersByTime(500);
    await assertion;
  });

  it('rejects an HTML5 seeked event that did not reach the requested target', async () => {
    const video = document.createElement('video');
    const promise = seekHtml5(video, 25, 1_000);
    video.currentTime = 4;
    video.dispatchEvent(new Event('seeked'));
    await expect(promise).rejects.toThrow('target');
  });

  it('aborts an in-flight HTML5 seek so a later manual position wins', async () => {
    const controller = new AbortController();
    const video = document.createElement('video');
    const automaticSeek = seekHtml5(video, 25, 1_000, controller.signal);

    controller.abort();
    video.currentTime = 42;
    video.dispatchEvent(new Event('seeked'));

    await expect(automaticSeek).rejects.toMatchObject({ name: 'AbortError' });
    expect(video.currentTime).toBe(42);
  });

  it('bounds seek retries and backoff delays', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('seek failed'));
    const wait = vi.fn(async () => {});

    await expect(retryPlaybackSeek(operation, {
      maxAttempts: 3,
      backoffMs: [20, 50],
      wait,
    })).rejects.toThrow('seek failed');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 20);
    expect(wait).toHaveBeenNthCalledWith(2, 50);
  });

  it('does not retry after a seek intent is aborted', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new Error('stale automatic seek');
    });
    const wait = vi.fn(async () => {});

    await expect(retryPlaybackSeek(operation, {
      maxAttempts: 3,
      wait,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('supports AVPlay callback completion and reports callback failure', async () => {
    const successManager = {
      seekTo: vi.fn((_ms: number, success?: () => void) => success?.()),
    };
    await expect(seekAvPlay(successManager, 12, 1_000)).resolves.toBeUndefined();
    expect(successManager.seekTo).toHaveBeenCalledWith(12_000, expect.any(Function), expect.any(Function));

    const errorManager = {
      seekTo: vi.fn((_ms: number, _success?: () => void, failure?: (error: Error) => void) => failure?.(new Error('native failure'))),
    };
    await expect(seekAvPlay(errorManager, 12, 1_000)).rejects.toThrow('native failure');
  });

  it('reapplies the latest AVPlay intent after an aborted native seek completes late', async () => {
    const controller = new AbortController();
    let staleSuccess: (() => void) | undefined;
    let currentPositionMs = 0;
    const manager = {
      seekTo: vi.fn((positionMs: number, success?: () => void) => {
        if (!staleSuccess) {
          staleSuccess = () => {
            currentPositionMs = positionMs;
            success?.();
          };
          return;
        }
        currentPositionMs = positionMs;
        success?.();
      }),
    };
    const restoreManualIntent = () => manager.seekTo(42_000);
    const automaticSeek = seekAvPlay(
      manager,
      25,
      1_000,
      controller.signal,
      restoreManualIntent,
    );

    controller.abort();
    manager.seekTo(42_000);
    staleSuccess?.();

    await expect(automaticSeek).rejects.toMatchObject({ name: 'AbortError' });
    expect(currentPositionMs).toBe(42_000);
    expect(manager.seekTo.mock.calls.map(([position]) => position)).toEqual([
      25_000, 42_000, 42_000,
    ]);
  });

  it('supports firmware that returns a promise from AVPlay seekTo', async () => {
    const manager = {
      seekTo: vi.fn(() => Promise.resolve()),
    };
    await expect(seekAvPlay(manager, 4, 1_000)).resolves.toBeUndefined();
  });
});

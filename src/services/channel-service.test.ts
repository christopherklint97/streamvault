import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllWatchProgress,
  getContinueWatchingIds,
  getLatestSeriesProgress,
  getSeriesWatchProgress,
  getWatchProgress,
  saveWatchProgress,
} from './channel-service';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    key: () => null,
    get length() { return storage.size; },
  };
});

afterEach(() => {
  clearAllWatchProgress();
  vi.useRealTimers();
});

describe('watch progress', () => {
  it('keeps HLS progress when the growing playlist has no finite duration', () => {
    saveWatchProgress('vod_manual', 120, 0, 'movies');

    expect(getWatchProgress('vod_manual')).toMatchObject({
      position: 120,
      duration: 0,
      contentType: 'movies',
    });
    expect(getContinueWatchingIds()).toEqual(['vod_manual']);
  });

  it('keeps series progress under the prefixed library ID when iPhone HLS has no finite duration', () => {
    saveWatchProgress('episode_177574', 120, 0, 'series', 'series_2963');

    expect(getWatchProgress('episode_177574')).toMatchObject({
      position: 120,
      duration: 0,
      contentType: 'series',
      seriesId: 'series_2963',
      completed: false,
    });
    expect(getContinueWatchingIds()).toEqual(['series_2963']);
  });

  it('marks an ended unknown-duration episode complete even when it is shorter than the save threshold', () => {
    saveWatchProgress('episode_177574', 5, 0, 'series', 'series_2963', true);

    expect(getWatchProgress('episode_177574')).toMatchObject({
      position: 5,
      duration: 0,
      completed: true,
      seriesId: 'series_2963',
    });
  });

  it('keeps terminal completion sticky until the episode is explicitly replayed', () => {
    saveWatchProgress('episode_177574', 420, 0, 'series', 'series_2963', true);
    saveWatchProgress('episode_177574', 420, 0, 'series', 'series_2963');
    expect(getWatchProgress('episode_177574')?.completed).toBe(true);

    saveWatchProgress('episode_177574', 20, 0, 'series', 'series_2963');
    expect(getWatchProgress('episode_177574')?.completed).toBe(false);
  });

  it('retains completed episode history but removes a completed movie', () => {
    saveWatchProgress('episode_177574', 950, 1000, 'series', 'series_2963');
    saveWatchProgress('vod_42', 950, 1000, 'movies');

    expect(getWatchProgress('episode_177574')).toMatchObject({
      completed: true,
      seriesId: 'series_2963',
    });
    expect(getWatchProgress('vod_42')).toBeNull();
    expect(getContinueWatchingIds()).toEqual(['series_2963']);
  });

  it('keeps enough completed episode history for long-running series', () => {
    for (let index = 1; index <= 150; index += 1) {
      vi.setSystemTime(index);
      saveWatchProgress(`episode_${index}`, 950, 1000, 'series', 'series_long');
    }

    expect(getWatchProgress('episode_1')?.completed).toBe(true);
    expect(getWatchProgress('episode_150')?.completed).toBe(true);
    expect(getContinueWatchingIds()).toEqual(['series_long']);
  });

  it('returns the latest unfinished episode for a series progress card', () => {
    vi.setSystemTime(10);
    saveWatchProgress('episode_1', 300, 1000, 'series', 'series_2963');
    vi.setSystemTime(20);
    saveWatchProgress('episode_2', 950, 1000, 'series', 'series_2963');

    expect(getLatestSeriesProgress('series_2963')?.channelId).toBe('episode_1');
    expect(Object.keys(getSeriesWatchProgress('series_2963')).sort()).toEqual(['episode_1', 'episode_2']);
  });
});

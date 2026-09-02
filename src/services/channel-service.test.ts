import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllWatchProgress, getContinueWatchingIds, getWatchProgress, saveWatchProgress } from './channel-service';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
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
});

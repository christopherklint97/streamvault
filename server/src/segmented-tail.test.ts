import { describe, expect, it, vi } from 'vitest';
import { waitForSharedArchiveTail } from './segmented-tail.js';

describe('shared archive tail finalization', () => {
  it('waits for the published chunk covering the show end', async () => {
    vi.useFakeTimers();
    try {
      let publishedEnd = 10_000;
      const pending = waitForSharedArchiveTail(() => publishedEnd, 20_000, 8_000, 1000);
      await vi.advanceTimersByTimeAsync(1500);
      publishedEnd = 20_100;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('bounds waiting when the source stalls', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForSharedArchiveTail(() => 10_000, 20_000, 3_000, 1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

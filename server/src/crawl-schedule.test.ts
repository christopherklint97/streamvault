// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nextScheduledCrawl, shouldCrawlAtStartup } from './crawl-schedule.js';

describe('full catalog crawl scheduling', () => {
  it('schedules the next crawl for 04:00 local time', () => {
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 3, 30))).toEqual(new Date(2026, 8, 17, 4));
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 4, 0))).toEqual(new Date(2026, 8, 18, 4));
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 19, 0))).toEqual(new Date(2026, 8, 18, 4));
  });

  it('honors Europe/Stockholm wall time across CET, CEST, and DST transitions', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Europe/Stockholm';
    try {
      expect(nextScheduledCrawl(new Date('2026-01-22T02:00:00Z')).toISOString()).toBe('2026-01-22T03:00:00.000Z');
      expect(nextScheduledCrawl(new Date('2026-09-22T00:00:00Z')).toISOString()).toBe('2026-09-22T02:00:00.000Z');
      expect(nextScheduledCrawl(new Date('2026-03-29T00:30:00Z')).toISOString()).toBe('2026-03-29T02:00:00.000Z');
      expect(nextScheduledCrawl(new Date('2026-10-25T00:30:00Z')).toISOString()).toBe('2026-10-25T03:00:00.000Z');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('only starts an immediate crawl when no cached catalog exists', () => {
    expect(shouldCrawlAtStartup(0)).toBe(true);
    expect(shouldCrawlAtStartup(1)).toBe(false);
    expect(shouldCrawlAtStartup(236_576)).toBe(false);
  });
});

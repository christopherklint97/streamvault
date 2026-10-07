// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nextScheduledCrawl, shouldCrawlAtStartup } from './crawl-schedule.js';

describe('full catalog crawl scheduling', () => {
  it('schedules the next crawl for 03:00 local time', () => {
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 2, 30))).toEqual(new Date(2026, 8, 17, 3));
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 3, 0))).toEqual(new Date(2026, 8, 18, 3));
    expect(nextScheduledCrawl(new Date(2026, 8, 17, 19, 0))).toEqual(new Date(2026, 8, 18, 3));
  });

  it('only starts an immediate crawl when no cached catalog exists', () => {
    expect(shouldCrawlAtStartup(0)).toBe(true);
    expect(shouldCrawlAtStartup(1)).toBe(false);
    expect(shouldCrawlAtStartup(236_576)).toBe(false);
  });
});

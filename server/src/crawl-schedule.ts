export const CRAWL_HOUR = 4;

/** Full catalog crawls are expensive, so run them once during the quietest hour. */
export function nextScheduledCrawl(now: Date): Date {
  const next = new Date(now);
  next.setHours(CRAWL_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** A restart may resume from cached data; only an empty catalog needs an immediate crawl. */
export function shouldCrawlAtStartup(channelCount: number): boolean {
  return channelCount === 0;
}

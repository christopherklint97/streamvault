import { createHash } from 'node:crypto';

function digest(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

/**
 * Airing identity is provider-event based when available. A time-based fallback
 * deliberately identifies only the transmission, never generic content.
 */
export function buildAiringKey(
  source: string,
  channelId: string,
  providerEventId: string | null | undefined,
  startTime: number,
  stopTime: number,
): string {
  const identity = providerEventId
    ? ['event', source, channelId, providerEventId]
    : ['time', source, channelId, startTime, stopTime];
  return `${source}:${digest(identity)}`;
}

/** Only explicit provider content identity is safe for repeat suppression. */
export function buildContentKey(
  source: string,
  providerContentId: string | null | undefined,
): string | null {
  return providerContentId ? `${source}:${digest(['content', providerContentId])}` : null;
}

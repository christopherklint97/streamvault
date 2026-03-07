import type { Program } from '../types';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Parse XMLTV EPG data into Program objects.
 * Only keeps programs whose start is within 24 hours from now.
 * Infers missing stop times from the next programme on the same channel.
 */
export function parseEPG(xmlText: string): Program[] {
  const programs: Program[] = [];
  const now = Date.now();
  const cutoff = now + TWENTY_FOUR_HOURS_MS;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const programmeElements = doc.querySelectorAll('programme');

    programmeElements.forEach((el) => {
      const channelId = el.getAttribute('channel') || '';
      const startStr = el.getAttribute('start') || '';
      const stopStr = el.getAttribute('stop') || '';

      const titleEl = el.querySelector('title');
      const descEl = el.querySelector('desc');
      const categoryEl = el.querySelector('category');

      const title = titleEl?.textContent || 'No Title';
      const description = descEl?.textContent || '';
      const category = categoryEl?.textContent || 'General';

      const start = parseXMLTVDate(startStr);
      const stop = stopStr ? parseXMLTVDate(stopStr) : null;

      if (start && start.getTime() < cutoff) {
        programs.push({
          channelId,
          title,
          description,
          start,
          stop: stop ?? start, // temporary placeholder if missing
          category,
        });
      }
    });
  } catch {
    // Return empty array on parse failure
  }

  // Sort by channel + start time to infer missing stop times
  programs.sort((a, b) => {
    if (a.channelId < b.channelId) return -1;
    if (a.channelId > b.channelId) return 1;
    return a.start.getTime() - b.start.getTime();
  });

  // Fill in missing stop times: if stop === start (placeholder), use next programme's start
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    if (p.stop.getTime() === p.start.getTime()) {
      // Find the next programme on the same channel
      const next = programs[i + 1];
      if (next && next.channelId === p.channelId) {
        p.stop = next.start;
      } else {
        // No next programme — assume 30 minutes
        p.stop = new Date(p.start.getTime() + 30 * 60 * 1000);
      }
    }
  }

  return programs;
}

/** Backward-compatible alias for parseEPG. */
export const fetchEPG = parseEPG;

/**
 * Fetch EPG data from a URL, with gzip support, and parse it.
 */
export async function fetchEPGFromUrl(url: string): Promise<Program[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('Content-Type') || '';
  const isGzip = url.endsWith('.gz') || contentType.includes('gzip');

  let xmlText: string;

  if (isGzip && response.body) {
    const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
    const reader = decompressed.getReader();
    const chunks: Uint8Array[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    xmlText = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') +
      decoder.decode();
  } else {
    xmlText = await response.text();
  }

  return parseEPG(xmlText);
}

/**
 * Parse XMLTV date format: 20230101120000 +0000
 */
function parseXMLTVDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.length < 14) return null;

  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10) - 1;
  const day = parseInt(dateStr.substring(6, 8), 10);
  const hour = parseInt(dateStr.substring(8, 10), 10);
  const minute = parseInt(dateStr.substring(10, 12), 10);
  const second = parseInt(dateStr.substring(12, 14), 10);

  const offsetMatch = dateStr.match(/([+-]\d{4})/);
  if (offsetMatch) {
    const offsetStr = offsetMatch[1];
    const offsetSign = offsetStr[0] === '+' ? 1 : -1;
    const offsetHours = parseInt(offsetStr.substring(1, 3), 10);
    const offsetMinutes = parseInt(offsetStr.substring(3, 5), 10);
    const totalOffsetMs = offsetSign * (offsetHours * 60 + offsetMinutes) * 60000;

    const utcMs = Date.UTC(year, month, day, hour, minute, second) - totalOffsetMs;
    return new Date(utcMs);
  }

  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/**
 * Get the currently airing program for a channel.
 * When channelPrograms is provided, it should be the pre-filtered array for
 * that channel (from programsByChannel), and channelId filtering is skipped.
 */
export function getCurrentProgram(
  programs: Program[],
  channelId: string,
  channelPrograms?: Program[],
): Program | null {
  const now = new Date();
  const source = channelPrograms ?? programs;
  return (
    source.find(
      (p) =>
        (channelPrograms || p.channelId === channelId) &&
        p.start <= now &&
        p.stop > now
    ) || null
  );
}

/**
 * Get the next program for a channel.
 * When channelPrograms is provided, it should be the pre-filtered array for
 * that channel (from programsByChannel), and channelId filtering is skipped.
 */
export function getNextProgram(
  programs: Program[],
  channelId: string,
  channelPrograms?: Program[],
): Program | null {
  const now = new Date();
  const source = channelPrograms ?? programs;
  const upcoming = source
    .filter(
      (p) =>
        (channelPrograms || p.channelId === channelId) && p.start > now
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return upcoming[0] || null;
}

/**
 * Get programs for a specific channel on a specific day (midnight to midnight).
 */
export function getChannelPrograms(programs: Program[], channelId: string, date: Date): Program[] {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart.getTime() + TWENTY_FOUR_HOURS_MS);

  return programs.filter(
    (p) =>
      p.channelId === channelId &&
      p.start < dayEnd &&
      p.stop > dayStart
  );
}

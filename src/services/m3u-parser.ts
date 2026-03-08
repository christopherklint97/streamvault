import type { Channel, ContentType } from '../types';

/**
 * Generate a stable ID from channel name and URL using a simple hash.
 * Uses DJB2 hash algorithm for fast, reasonably distributed hashing.
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(36);
}

function generateChannelId(name: string, url: string): string {
  return hashString(name + '|' + url);
}

/**
 * Infer content type from group-title and channel name.
 * Detects movies, series, or defaults to live TV.
 */
function inferContentType(group: string, name: string): ContentType {
  const lower = (group + ' ' + name).toLowerCase();
  // Movies detection
  if (lower.includes('movie') || lower.includes('film') || lower.includes('vod') ||
      lower.includes('cinema') || lower.includes('flick')) {
    return 'movies';
  }
  // Series detection
  if (lower.includes('series') || lower.includes('show') || lower.includes('episode') ||
      lower.includes('season') || lower.includes('tv show') || lower.includes('sitcom') ||
      lower.includes('drama')) {
    return 'series';
  }
  // Default to live TV
  return 'livetv';
}

/**
 * Extract an attribute value from an #EXTINF line.
 * Handles both quoted and unquoted attribute values.
 * Example: tvg-name="My Channel" -> "My Channel"
 */
function extractAttribute(line: string, attr: string): string {
  // Match attribute="value" (double quotes)
  const doubleQuoteRegex = new RegExp(attr + '="([^"]*)"', 'i');
  const doubleMatch = line.match(doubleQuoteRegex);
  if (doubleMatch) {
    return doubleMatch[1];
  }

  // Match attribute='value' (single quotes)
  const singleQuoteRegex = new RegExp(attr + "='([^']*)'", 'i');
  const singleMatch = line.match(singleQuoteRegex);
  if (singleMatch) {
    return singleMatch[1];
  }

  return '';
}

/**
 * Extract the display name from the end of an #EXTINF line.
 * The display name follows the last comma that is not inside quotes.
 * Example: #EXTINF:-1 tvg-name="X",My Channel -> "My Channel"
 */
function extractDisplayName(line: string): string {
  // Find the last comma that separates attributes from the display name.
  // We need to handle commas inside quoted attribute values.
  let inQuote = false;
  let quoteChar = '';
  let lastCommaIndex = -1;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ',') {
        lastCommaIndex = i;
      }
    }
  }

  if (lastCommaIndex === -1) {
    return '';
  }

  return line.substring(lastCommaIndex + 1).trim();
}

/**
 * Strip UTF-8 BOM and normalize line endings.
 */
function normalizeContent(content: string): string {
  // Remove UTF-8 BOM if present
  let normalized = content;
  if (normalized.charCodeAt(0) === 0xfeff) {
    normalized = normalized.substring(1);
  }

  // Normalize line endings to \n
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return normalized;
}

export interface ParseProgress {
  parsed: number;
  total: number;
}

/**
 * Parse M3U/M3U8 playlist content into an array of Channel objects.
 * Async with chunked processing to keep UI responsive.
 * Deduplicates channels by URL, keeping the first occurrence.
 */
export async function parseM3U(
  content: string,
  onProgress?: (progress: ParseProgress) => void,
  signal?: AbortSignal,
): Promise<Channel[]> {
  const normalized = normalizeContent(content);
  const lines = normalized.split('\n');
  const channels: Channel[] = [];
  const seenUrls = new Set<string>();
  const totalLines = lines.length;

  let currentExtInf: string | null = null;
  const YIELD_EVERY = 2000; // yield to UI every N lines

  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) return channels;

    // Yield to UI periodically
    if (i > 0 && i % YIELD_EVERY === 0) {
      onProgress?.({ parsed: channels.length, total: Math.floor(totalLines / 2) });
      await new Promise((r) => setTimeout(r, 0));
    }

    const line = lines[i].trim();

    if (line === '') continue;
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = line;
    if (!currentExtInf) continue;

    if (seenUrls.has(url)) {
      currentExtInf = null;
      continue;
    }
    seenUrls.add(url);

    const tvgName = extractAttribute(currentExtInf, 'tvg-name');
    const tvgLogo = extractAttribute(currentExtInf, 'tvg-logo');
    const groupTitle = extractAttribute(currentExtInf, 'group-title');
    const tvgCountry = extractAttribute(currentExtInf, 'tvg-country');

    const displayName = extractDisplayName(currentExtInf);
    const name = tvgName || displayName || 'Unknown Channel';

    const channel: Channel = {
      id: generateChannelId(name, url),
      name: name,
      url: url,
      logo: tvgLogo,
      group: groupTitle || 'Uncategorized',
      region: tvgCountry || '',
      contentType: inferContentType(groupTitle, name),
      isFavorite: false,
    };

    channels.push(channel);
    currentExtInf = null;
  }

  onProgress?.({ parsed: channels.length, total: channels.length });
  return channels;
}

/**
 * Fetch an M3U/M3U8 playlist from a URL and parse it into channels.
 */
export async function parseM3UFromUrl(
  url: string,
  onProgress?: (progress: ParseProgress) => void,
  signal?: AbortSignal,
): Promise<Channel[]> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch M3U playlist: ${response.status} ${response.statusText}`
    );
  }
  const content = await response.text();
  return parseM3U(content, onProgress, signal);
}

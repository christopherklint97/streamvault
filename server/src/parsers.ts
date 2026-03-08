import type { DBChannel, DBProgram } from './db.js';

// ---------- M3U Parser ----------

function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(36);
}

function extractAttribute(line: string, attr: string): string {
  const doubleMatch = line.match(new RegExp(attr + '="([^"]*)"', 'i'));
  if (doubleMatch) return doubleMatch[1];
  const singleMatch = line.match(new RegExp(attr + "='([^']*)'", 'i'));
  if (singleMatch) return singleMatch[1];
  return '';
}

function extractDisplayName(line: string): string {
  let inQuote = false;
  let quoteChar = '';
  let lastCommaIndex = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      else if (ch === ',') lastCommaIndex = i;
    }
  }
  return lastCommaIndex === -1 ? '' : line.substring(lastCommaIndex + 1).trim();
}

function inferContentType(group: string, name: string): string {
  const lower = (group + ' ' + name).toLowerCase();
  if (lower.includes('movie') || lower.includes('film') || lower.includes('vod') ||
      lower.includes('cinema') || lower.includes('flick')) return 'movies';
  if (lower.includes('series') || lower.includes('show') || lower.includes('episode') ||
      lower.includes('season') || lower.includes('tv show') || lower.includes('sitcom') ||
      lower.includes('drama')) return 'series';
  return 'livetv';
}

export function parseM3U(content: string): DBChannel[] {
  // Remove BOM, normalize line endings
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = text.split('\n');
  const channels: DBChannel[] = [];
  const seenUrls = new Set<string>();
  let currentExtInf: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
      continue;
    }
    if (line.startsWith('#')) continue;

    const url = line;
    if (!currentExtInf || seenUrls.has(url)) {
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
    const group = groupTitle || 'Uncategorized';

    channels.push({
      id: hashString(name + '|' + url),
      name,
      url,
      logo: tvgLogo,
      grp: group,
      region: tvgCountry || '',
      content_type: inferContentType(group, name),
    });

    currentExtInf = null;
  }

  return channels;
}

// ---------- EPG Parser (regex-based, no DOMParser) ----------

function parseXMLTVDate(dateStr: string): number | null {
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
    const sign = offsetStr[0] === '+' ? 1 : -1;
    const offsetH = parseInt(offsetStr.substring(1, 3), 10);
    const offsetM = parseInt(offsetStr.substring(3, 5), 10);
    const totalOffsetMs = sign * (offsetH * 60 + offsetM) * 60000;
    return Date.UTC(year, month, day, hour, minute, second) - totalOffsetMs;
  }
  return Date.UTC(year, month, day, hour, minute, second);
}

function getTagContent(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function getAttr(tag: string, attr: string): string {
  const match = tag.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

export function parseEPG(xmlText: string): DBProgram[] {
  const programs: DBProgram[] = [];
  const now = Date.now();
  const cutoff = now + 24 * 60 * 60 * 1000;

  // Match each <programme ...>...</programme> block
  const programRegex = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match;

  while ((match = programRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const channelId = getAttr(attrs, 'channel');
    const startStr = getAttr(attrs, 'start');
    const stopStr = getAttr(attrs, 'stop');

    const startTime = parseXMLTVDate(startStr);
    if (!startTime || startTime > cutoff) continue;

    const stopTime = stopStr ? parseXMLTVDate(stopStr) : null;
    const title = getTagContent(body, 'title') || 'No Title';
    const description = getTagContent(body, 'desc');
    const category = getTagContent(body, 'category') || 'General';

    programs.push({
      channel_id: channelId,
      title,
      description,
      start_time: startTime,
      stop_time: stopTime ?? startTime,
      category,
    });
  }

  // Sort by channel + start time
  programs.sort((a, b) => {
    if (a.channel_id < b.channel_id) return -1;
    if (a.channel_id > b.channel_id) return 1;
    return a.start_time - b.start_time;
  });

  // Infer missing stop times
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    if (p.stop_time === p.start_time) {
      const next = programs[i + 1];
      if (next && next.channel_id === p.channel_id) {
        p.stop_time = next.start_time;
      } else {
        p.stop_time = p.start_time + 30 * 60 * 1000;
      }
    }
  }

  return programs;
}

import type { DBCategory, DBChannel, DBProgram } from './db.js';
import { logger } from './logger.js';

// ---------- Xtream JSON API types ----------

interface XtreamCategory {
  category_id: string;
  category_name: string;
}

interface XtreamLiveStream {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  epg_channel_id: string;
  category_id: string;
}

interface XtreamVodStream {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  category_id: string;
  container_extension: string;
}

interface XtreamSeries {
  num: number;
  name: string;
  series_id: number;
  cover: string;
  category_id: string;
}

interface XtreamEpgEntry {
  id: string;
  epg_id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  channel_id: string;
}

interface XtreamShortEpg {
  epg_listings: XtreamEpgEntry[];
}

// ---------- API client ----------

export interface XtreamConfig {
  server: string;
  username: string;
  password: string;
}

function apiUrl(config: XtreamConfig, action?: string): string {
  let base = config.server.trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  const auth = `username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}`;
  const url = `${base}/player_api.php?${auth}`;
  return action ? `${url}&action=${action}` : url;
}

function streamUrl(config: XtreamConfig, streamId: number, type: 'live' | 'movie' | 'series', ext?: string): string {
  let base = config.server.trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  const u = encodeURIComponent(config.username);
  const p = encodeURIComponent(config.password);
  if (type === 'live') return `${base}/${u}/${p}/${streamId}`;
  return `${base}/${type}/${u}/${p}/${streamId}${ext ? '.' + ext : ''}`;
}

async function fetchJson<T>(url: string, signal: AbortSignal, label: string): Promise<T> {
  logger.debug(`Fetching ${label}`);
  const start = Date.now();
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as T;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.debug(`${label}: done (${elapsed}s)`);
  return data;
}

// ---------- Sync: categories only (fast) ----------

export async function fetchXtreamCategories(
  config: XtreamConfig,
  signal: AbortSignal,
): Promise<DBCategory[]> {
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    fetchJson<XtreamCategory[]>(apiUrl(config, 'get_live_categories'), signal, 'live categories'),
    fetchJson<XtreamCategory[]>(apiUrl(config, 'get_vod_categories'), signal, 'vod categories'),
    fetchJson<XtreamCategory[]>(apiUrl(config, 'get_series_categories'), signal, 'series categories'),
  ]);

  logger.info(`Categories: ${liveCats.length} live, ${vodCats.length} vod, ${seriesCats.length} series`);

  const categories: DBCategory[] = [];

  for (const c of liveCats) {
    categories.push({
      id: `live_${c.category_id}`,
      name: c.category_name,
      content_type: 'livetv',
      stream_count: 0,
      fetched_at: 0,
    });
  }
  for (const c of vodCats) {
    categories.push({
      id: `vod_${c.category_id}`,
      name: c.category_name,
      content_type: 'movies',
      stream_count: 0,
      fetched_at: 0,
    });
  }
  for (const c of seriesCats) {
    categories.push({
      id: `series_${c.category_id}`,
      name: c.category_name,
      content_type: 'series',
      stream_count: 0,
      fetched_at: 0,
    });
  }

  return categories;
}

// ---------- On-demand: fetch streams for a single category ----------

function parseCategoryId(prefixedId: string): { type: 'live' | 'vod' | 'series'; rawId: string } | null {
  if (prefixedId.startsWith('live_')) return { type: 'live', rawId: prefixedId.slice(5) };
  if (prefixedId.startsWith('vod_')) return { type: 'vod', rawId: prefixedId.slice(4) };
  if (prefixedId.startsWith('series_')) return { type: 'series', rawId: prefixedId.slice(7) };
  return null;
}

export async function fetchXtreamStreamsByCategory(
  config: XtreamConfig,
  categoryId: string,
  categoryName: string,
): Promise<DBChannel[]> {
  const parsed = parseCategoryId(categoryId);
  if (!parsed) throw new Error(`Invalid category ID: ${categoryId}`);

  const { type, rawId } = parsed;
  const channels: DBChannel[] = [];

  if (type === 'live') {
    const streams = await fetchJson<XtreamLiveStream[]>(
      apiUrl(config, `get_live_streams&category_id=${rawId}`),
      AbortSignal.timeout(60_000),
      `live streams cat ${rawId}`,
    );
    for (const s of streams) {
      channels.push({
        id: `live_${s.stream_id}`,
        name: s.name,
        url: streamUrl(config, s.stream_id, 'live'),
        logo: s.stream_icon || '',
        grp: categoryName,
        region: '',
        content_type: 'livetv',
        category_id: categoryId,
      });
    }
  } else if (type === 'vod') {
    const streams = await fetchJson<XtreamVodStream[]>(
      apiUrl(config, `get_vod_streams&category_id=${rawId}`),
      AbortSignal.timeout(60_000),
      `vod streams cat ${rawId}`,
    );
    for (const s of streams) {
      channels.push({
        id: `vod_${s.stream_id}`,
        name: s.name,
        url: streamUrl(config, s.stream_id, 'movie', s.container_extension),
        logo: s.stream_icon || '',
        grp: categoryName,
        region: '',
        content_type: 'movies',
        category_id: categoryId,
      });
    }
  } else {
    const series = await fetchJson<XtreamSeries[]>(
      apiUrl(config, `get_series&category_id=${rawId}`),
      AbortSignal.timeout(60_000),
      `series cat ${rawId}`,
    );
    for (const s of series) {
      channels.push({
        id: `series_${s.series_id}`,
        name: s.name,
        url: '',
        logo: s.cover || '',
        grp: categoryName,
        region: '',
        content_type: 'series',
        category_id: categoryId,
      });
    }
  }

  logger.info(`Fetched ${channels.length} streams for category "${categoryName}" (${categoryId})`);
  return channels;
}

// ---------- On-demand: short EPG for specific streams ----------

export async function fetchXtreamShortEpg(
  config: XtreamConfig,
  streamIds: number[],
): Promise<DBProgram[]> {
  const programs: DBProgram[] = [];
  const BATCH = 10;

  for (let i = 0; i < streamIds.length; i += BATCH) {
    const batch = streamIds.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(id =>
        fetchJson<XtreamShortEpg>(
          apiUrl(config, `get_short_epg&stream_id=${id}&limit=10`),
          AbortSignal.timeout(30_000),
          `epg ${id}`,
        ).catch(() => ({ epg_listings: [] } as XtreamShortEpg))
      )
    );

    for (const result of results) {
      for (const e of result.epg_listings) {
        const start = parseEpgTimestamp(e.start);
        const stop = parseEpgTimestamp(e.end);
        if (!start || !stop) continue;
        programs.push({
          channel_id: e.channel_id || e.epg_id,
          title: decodeBase64Maybe(e.title) || 'No Title',
          description: decodeBase64Maybe(e.description) || '',
          start_time: start,
          stop_time: stop,
          category: '',
        });
      }
    }
  }

  return programs;
}

function parseEpgTimestamp(str: string): number | null {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function decodeBase64Maybe(str: string): string {
  if (!str) return '';
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(str) && str.length > 10) {
      return Buffer.from(str, 'base64').toString('utf-8');
    }
  } catch { /* not base64 */ }
  return str;
}

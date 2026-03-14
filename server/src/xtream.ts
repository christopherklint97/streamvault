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

// ---------- VOD info types ----------

interface XtreamVodInfo {
  info: {
    name: string;
    o_name?: string;
    cover_big?: string;
    movie_image?: string;
    plot?: string;
    genre?: string;
    releasedate?: string;
    rating?: string;
    cast?: string;
    director?: string;
    duration?: string;
    tmdb_id?: string;
    backdrop_path?: string[];
  };
  movie_data: {
    stream_id: number;
    name: string;
    container_extension: string;
  };
}

export interface VodInfoResult {
  name: string;
  cover: string;
  plot: string;
  genre: string;
  releaseDate: string;
  rating: string;
  cast: string;
  director: string;
  duration: string;
  tmdbId: string;
}

// ---------- Series info types ----------

interface XtreamSeriesInfo {
  seasons: Array<{
    air_date: string;
    episode_count: number;
    id: number;
    name: string;
    overview: string;
    season_number: number;
    cover: string;
  }>;
  episodes: Record<string, Array<{
    id: string;
    episode_num: number;
    title: string;
    container_extension: string;
    season: number;
    info: {
      duration?: string;
      plot?: string;
      movie_image?: string;
      rating?: number;
      name?: string;
    };
  }>>;
  info: {
    name: string;
    cover: string;
    plot: string;
    genre: string;
    release_date: string;
    rating: string;
    cast: string;
    director: string;
  };
}

export interface SeriesInfoResult {
  name: string;
  cover: string;
  plot: string;
  genre: string;
  releaseDate: string;
  rating: string;
  cast: string;
  director: string;
  seasons: Array<{
    seasonNumber: number;
    name: string;
    episodeCount: number;
    cover: string;
  }>;
  episodes: Record<number, Array<{
    id: string;
    episodeNum: number;
    title: string;
    season: number;
    url: string;
    containerExtension: string;
    duration: string;
    plot: string;
    image: string;
    rating: number;
  }>>;
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

function streamUrl(config: XtreamConfig, streamId: number, type: 'live' | 'movie' | 'series', extension?: string): string {
  let base = config.server.trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  const u = encodeURIComponent(config.username);
  const p = encodeURIComponent(config.password);
  if (type === 'live') return `${base}/${u}/${p}/${streamId}`;
  // Include container extension for VOD — most providers require it
  const ext = extension ? `.${extension}` : '';
  return `${base}/${type}/${u}/${p}/${streamId}${ext}`;
}

const VLC_HEADERS = {
  'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
  'Accept': '*/*',
};

async function fetchJson<T>(url: string, signal: AbortSignal, label: string): Promise<T> {
  logger.debug(`Fetching ${label}`);
  const start = Date.now();
  const response = await fetch(url, { signal, headers: VLC_HEADERS });
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
  timeoutMs = 180_000,
): Promise<DBChannel[]> {
  const parsed = parseCategoryId(categoryId);
  if (!parsed) throw new Error(`Invalid category ID: ${categoryId}`);

  const { type, rawId } = parsed;
  const channels: DBChannel[] = [];

  if (type === 'live') {
    const streams = await fetchJson<XtreamLiveStream[]>(
      apiUrl(config, `get_live_streams&category_id=${rawId}`),
      AbortSignal.timeout(timeoutMs),
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
        sort_order: s.num || 0,
      });
    }
  } else if (type === 'vod') {
    const streams = await fetchJson<XtreamVodStream[]>(
      apiUrl(config, `get_vod_streams&category_id=${rawId}`),
      AbortSignal.timeout(timeoutMs),
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
        sort_order: s.num || 0,
      });
    }
  } else {
    const series = await fetchJson<XtreamSeries[]>(
      apiUrl(config, `get_series&category_id=${rawId}`),
      AbortSignal.timeout(timeoutMs),
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
        sort_order: s.num || 0,
      });
    }
  }

  logger.info(`Fetched ${channels.length} streams for category "${categoryName}" (${categoryId})`);
  return channels;
}

// ---------- Fetch all categories' streams with controlled parallelism ----------

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchAllCategoryStreams(
  config: XtreamConfig,
  categories: Array<{ id: string; name: string }>,
  onCategoryDone: (categoryId: string, channels: DBChannel[]) => void,
  concurrency = 2,
  signal?: AbortSignal,
): Promise<number> {
  let totalFetched = 0;
  let completed = 0;
  let consecutiveErrors = 0;
  const total = categories.length;
  const queue = [...categories];
  const retryQueue: Array<{ id: string; name: string }> = [];
  const MAX_RETRIES = 2;

  async function processQueue(q: Array<{ id: string; name: string }>, isRetry: boolean): Promise<void> {
    const timeout = isRetry ? 360_000 : 180_000; // 6min on retry, 3min on first pass
    async function worker(): Promise<void> {
      while (q.length > 0) {
        if (signal?.aborted) return;
        const cat = q.shift()!;
        try {
          const channels = await fetchXtreamStreamsByCategory(config, cat.id, cat.name, timeout);
          onCategoryDone(cat.id, channels);
          totalFetched += channels.length;
          completed++;
          consecutiveErrors = 0;
          if (completed % 20 === 0 || completed === total) {
            logger.info(`Stream crawl progress: ${completed}/${total} categories, ${totalFetched} streams`);
          }
        } catch (err) {
          completed++;
          consecutiveErrors++;
          const msg = err instanceof Error ? err.message : 'Unknown error';
          logger.warn(`Failed to fetch category "${cat.name}": ${msg}`);
          if (!isRetry) {
            retryQueue.push(cat);
          }
          if (consecutiveErrors >= 3) {
            const backoff = Math.min(consecutiveErrors * 2000, 15000);
            logger.info(`Backing off ${backoff / 1000}s after ${consecutiveErrors} consecutive errors`);
            await delay(backoff);
          }
        }
        await delay(isRetry ? 2000 : 500);
      }
    }

    const workerCount = isRetry ? 1 : Math.min(concurrency, q.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  // Main pass
  await processQueue(queue, false);

  // Retry failed categories (up to MAX_RETRIES passes, single worker, slower pace)
  for (let attempt = 1; attempt <= MAX_RETRIES && retryQueue.length > 0; attempt++) {
    if (signal?.aborted) break;
    const toRetry = retryQueue.splice(0);
    logger.info(`Retry pass ${attempt}: ${toRetry.length} failed categories (waiting 10s before starting)`);
    await delay(10_000);
    await processQueue(toRetry, true);
  }

  if (retryQueue.length > 0) {
    logger.warn(`${retryQueue.length} categories still failed after ${MAX_RETRIES} retries: ${retryQueue.map(c => c.name).join(', ')}`);
  }

  logger.info(`Stream crawl complete: ${totalFetched} streams from ${total} categories`);
  return totalFetched;
}

// ---------- On-demand: series info ----------

export async function fetchXtreamSeriesInfo(
  config: XtreamConfig,
  seriesId: number,
): Promise<SeriesInfoResult> {
  const data = await fetchJson<XtreamSeriesInfo>(
    apiUrl(config, `get_series_info&series_id=${seriesId}`),
    AbortSignal.timeout(30_000),
    `series info ${seriesId}`,
  );

  const info = data.info || {} as XtreamSeriesInfo['info'];

  const seasons = (data.seasons || [])
    .map(s => ({
      seasonNumber: s.season_number,
      name: s.name || `Season ${s.season_number}`,
      episodeCount: s.episode_count || 0,
      cover: s.cover || '',
    }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  const episodes: SeriesInfoResult['episodes'] = {};
  for (const [seasonNum, eps] of Object.entries(data.episodes || {})) {
    const sn = parseInt(seasonNum, 10);
    episodes[sn] = (eps || []).map(ep => ({
      id: ep.id,
      episodeNum: ep.episode_num,
      title: ep.title || ep.info?.name || `Episode ${ep.episode_num}`,
      season: ep.season || sn,
      url: streamUrl(config, parseInt(ep.id, 10), 'series', ep.container_extension),
      containerExtension: ep.container_extension || '',
      duration: ep.info?.duration || '',
      plot: ep.info?.plot || '',
      image: ep.info?.movie_image || '',
      rating: ep.info?.rating || 0,
    })).sort((a, b) => a.episodeNum - b.episodeNum);
  }

  return {
    name: info.name || '',
    cover: info.cover || '',
    plot: info.plot || '',
    genre: info.genre || '',
    releaseDate: info.release_date || '',
    rating: info.rating || '',
    cast: info.cast || '',
    director: info.director || '',
    seasons,
    episodes,
  };
}

// ---------- On-demand: VOD info ----------

export async function fetchXtreamVodInfo(
  config: XtreamConfig,
  vodId: number,
): Promise<VodInfoResult> {
  const data = await fetchJson<XtreamVodInfo>(
    apiUrl(config, `get_vod_info&vod_id=${vodId}`),
    AbortSignal.timeout(30_000),
    `vod info ${vodId}`,
  );

  const info = data.info || {} as XtreamVodInfo['info'];

  return {
    name: info.name || '',
    cover: info.cover_big || info.movie_image || '',
    plot: info.plot || '',
    genre: info.genre || '',
    releaseDate: info.releasedate || '',
    rating: info.rating || '',
    cast: info.cast || '',
    director: info.director || '',
    duration: info.duration || '',
    tmdbId: info.tmdb_id || '',
  };
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

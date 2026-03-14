import { gunzipSync } from 'node:zlib';
import { parseM3U, parseEPG } from './parsers.js';
import {
  saveChannels, savePrograms, saveCategories,
  getConfig, setConfig,
  getChannelCount, getProgramCount, getCategoryCount,
  saveChannelsForCategory, markCategoryFetched,
  saveProgramsForChannels,
} from './db.js';
import db from './db.js';
import { logger } from './logger.js';
import { fetchXtreamCategories, fetchAllCategoryStreams, fetchEpgForStreams } from './xtream.js';
import type { XtreamConfig } from './xtream.js';
import { matchRules } from './recording-scheduler.js';

export type SyncPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done' | 'error';

interface SyncState {
  isSyncing: boolean;
  phase: SyncPhase;
  message: string;
  channelCount: number;
  programCount: number;
  categoryCount: number;
  lastSyncTime: number;
  isCrawling: boolean;
  crawlProgress: string;
  lastCrawlTime: number;
}

const state: SyncState = {
  isSyncing: false,
  phase: 'idle',
  message: '',
  channelCount: 0,
  programCount: 0,
  categoryCount: 0,
  lastSyncTime: parseInt(getConfig('last_sync_time', '0'), 10),
  isCrawling: false,
  crawlProgress: '',
  lastCrawlTime: parseInt(getConfig('last_crawl_time', '0'), 10),
};

let abortController: AbortController | null = null;
let crawlAbortController: AbortController | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let nightlyCrawlTimer: ReturnType<typeof setTimeout> | null = null;

export function getStatus(): SyncState & { crawlAvailable: boolean } {
  if (!state.isSyncing) {
    state.channelCount = getChannelCount();
    state.programCount = getProgramCount();
    state.categoryCount = getCategoryCount();
    state.lastSyncTime = parseInt(getConfig('last_sync_time', '0'), 10);
    state.lastCrawlTime = parseInt(getConfig('last_crawl_time', '0'), 10);
  }
  return { ...state, crawlAvailable: !state.isCrawling && !!getXtreamConfig() };
}

// ---------- Xtream sync (categories only — fast) ----------

function getXtreamConfig(): XtreamConfig | null {
  const server = getConfig('xtream_server');
  const username = getConfig('xtream_username');
  const password = getConfig('xtream_password');
  if (!server || !username || !password) return null;
  return { server, username, password };
}

async function syncXtream(signal: AbortSignal): Promise<void> {
  const config = getXtreamConfig();
  if (!config) {
    state.phase = 'error';
    state.message = 'Xtream credentials not configured';
    logger.warn('Sync aborted: Xtream credentials not configured');
    return;
  }

  state.phase = 'fetching-playlist';
  state.message = 'Fetching categories...';
  logger.info('Xtream sync: fetching categories');

  const categories = await fetchXtreamCategories(config, signal);
  if (signal.aborted) return;

  saveCategories(categories);
  state.categoryCount = categories.length;
  state.message = `Synced ${categories.length} categories — streams load on-demand`;
  logger.info(`Saved ${categories.length} categories (streams will load on-demand)`);
}

// ---------- Full stream crawl (background, all categories) ----------

export async function startCrawl(): Promise<void> {
  if (state.isCrawling) {
    logger.info('Crawl already in progress');
    return;
  }

  const config = getXtreamConfig();
  if (!config) {
    logger.warn('Crawl aborted: no Xtream config');
    return;
  }

  const inputMode = getConfig('input_mode', 'manual');
  if (inputMode !== 'xtream') {
    logger.info('Crawl skipped: not in xtream mode');
    return;
  }

  crawlAbortController = new AbortController();
  const { signal } = crawlAbortController;
  state.isCrawling = true;
  state.crawlProgress = 'Starting full stream crawl...';
  logger.info('Starting full stream crawl...');

  try {
    // First ensure categories are up to date
    const categories = await fetchXtreamCategories(config, signal);
    if (signal.aborted) return;
    saveCategories(categories);

    const allCats = categories.map(c => ({ id: c.id, name: c.name }));
    state.crawlProgress = `Crawling ${allCats.length} categories...`;

    const totalStreams = await fetchAllCategoryStreams(
      config,
      allCats,
      (catId, channels) => {
        saveChannelsForCategory(catId, channels);
        markCategoryFetched(catId, channels.length);
      },
      2, // 2 concurrent workers (avoid overwhelming upstream server)
      signal,
    );

    if (!signal.aborted) {
      // Phase 2: Crawl EPG for live channels
      state.crawlProgress = 'Crawling EPG data for live channels...';
      logger.info('Starting EPG crawl for live channels...');
      try {
        const liveChannelRows = db.prepare(
          "SELECT id FROM channels WHERE content_type = 'livetv'"
        ).all() as Array<{ id: string }>;
        // Extract numeric stream IDs from channel IDs (format: live_12345)
        const liveStreamIds = liveChannelRows
          .map(r => parseInt(r.id.replace('live_', ''), 10))
          .filter(id => !isNaN(id));
        logger.info(`EPG crawl: ${liveStreamIds.length} live channels to fetch EPG for`);

        if (liveStreamIds.length > 0) {
          const epgTotal = await fetchEpgForStreams(
            config,
            liveStreamIds,
            (programs) => { saveProgramsForChannels(programs); },
            signal,
          );
          state.programCount = getProgramCount();
          logger.info(`EPG crawl complete: ${epgTotal} programs fetched`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        logger.warn(`EPG crawl failed (non-fatal): ${msg}`);
      }

      const now = Date.now();
      setConfig('last_crawl_time', String(now));
      state.lastCrawlTime = now;
      state.crawlProgress = `Crawl complete: ${totalStreams.toLocaleString()} streams`;
      state.channelCount = getChannelCount();
      logger.info(`Full crawl complete: ${totalStreams} streams from ${allCats.length} categories`);

      // Re-evaluate recording rules with new EPG data
      try {
        matchRules();
        logger.info('Post-crawl recording rule matching complete');
      } catch (err) {
        const ruleMsg = err instanceof Error ? err.message : 'Unknown error';
        logger.warn(`Post-crawl rule matching failed (non-fatal): ${ruleMsg}`);
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      state.crawlProgress = `Crawl failed: ${msg}`;
      logger.error(`Crawl failed: ${msg}`);
    }
  } finally {
    state.isCrawling = false;
    crawlAbortController = null;
    scheduleNightlyCrawl();
  }
}

export function cancelCrawl(): void {
  if (crawlAbortController) {
    crawlAbortController.abort();
    crawlAbortController = null;
  }
  state.isCrawling = false;
  state.crawlProgress = 'Crawl cancelled';
  logger.info('Crawl cancelled');
}

/** Schedule nightly crawl at 3 AM local time */
function scheduleNightlyCrawl(): void {
  if (nightlyCrawlTimer) { clearTimeout(nightlyCrawlTimer); nightlyCrawlTimer = null; }

  const inputMode = getConfig('input_mode', 'manual');
  if (inputMode !== 'xtream') return;
  if (!getXtreamConfig()) return;

  const now = new Date();
  const next3AM = new Date(now);
  next3AM.setHours(3, 0, 0, 0);
  if (next3AM.getTime() <= now.getTime()) {
    next3AM.setDate(next3AM.getDate() + 1);
  }
  const msUntil = next3AM.getTime() - now.getTime();
  const hoursUntil = (msUntil / 3600000).toFixed(1);

  nightlyCrawlTimer = setTimeout(() => {
    logger.info('Nightly crawl triggered');
    startCrawl();
  }, msUntil);

  logger.info(`Nightly crawl scheduled in ${hoursUntil}h (at ${next3AM.toLocaleTimeString()})`);
}

// ---------- Manual M3U/EPG sync ----------

function getManualUrls(): { playlistUrl: string; epgUrl: string } | null {
  const playlistUrl = getConfig('playlist_url');
  if (!playlistUrl) return null;
  return { playlistUrl, epgUrl: getConfig('epg_url') };
}

const CONNECT_TIMEOUT_MS = 60_000;

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  logger.debug(`Fetching ${url}`);
  const connectTimeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  const connectSignal = AbortSignal.any([signal, connectTimeout]);
  const response = await fetch(url, { signal: connectSignal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
  logger.info(`Response ${response.status}, downloading${totalBytes ? ` (${(totalBytes / 1024 / 1024).toFixed(1)} MB)` : ''}...`);

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastLog = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error('Aborted');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (Date.now() - lastLog > 10_000) {
      const mb = (received / 1024 / 1024).toFixed(1);
      const pct = totalBytes ? ` (${Math.round(received / totalBytes * 100)}%)` : '';
      logger.debug(`Downloaded ${mb} MB${pct}`);
      lastLog = Date.now();
    }
  }

  logger.info(`Download complete: ${(received / 1024 / 1024).toFixed(1)} MB`);
  const buffer = Buffer.concat(chunks);

  const isGzip = (buffer[0] === 0x1f && buffer[1] === 0x8b) || url.endsWith('.gz');
  if (isGzip) {
    logger.debug('Decompressing gzip data');
    return gunzipSync(buffer).toString('utf-8');
  }
  return buffer.toString('utf-8');
}

async function syncManual(signal: AbortSignal): Promise<void> {
  const urls = getManualUrls();
  if (!urls) {
    state.phase = 'error';
    state.message = 'No playlist URL configured';
    logger.warn('Sync aborted: no playlist URL configured');
    return;
  }

  state.phase = 'fetching-playlist';
  state.message = 'Downloading playlist...';
  logger.info('Manual sync started: fetching playlist');

  const playlistText = await fetchText(urls.playlistUrl, signal);
  if (signal.aborted) return;

  state.phase = 'parsing-playlist';
  state.message = 'Parsing channels...';
  const channels = parseM3U(playlistText);
  if (signal.aborted) return;

  saveChannels(channels);
  state.channelCount = channels.length;
  logger.info(`Parsed and saved ${channels.length.toLocaleString()} channels`);

  if (urls.epgUrl) {
    state.phase = 'fetching-epg';
    state.message = 'Downloading EPG data...';
    logger.info('Fetching EPG data');

    try {
      const epgText = await fetchText(urls.epgUrl, signal);
      if (signal.aborted) return;

      state.phase = 'parsing-epg';
      state.message = 'Parsing program guide...';
      const programs = parseEPG(epgText);
      if (signal.aborted) return;

      savePrograms(programs);
      state.programCount = programs.length;
      logger.info(`Sync complete: ${channels.length.toLocaleString()} channels, ${programs.length.toLocaleString()} programs`);
    } catch (err) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      state.message = `Channels loaded (EPG failed: ${msg})`;
      logger.error(`EPG fetch/parse failed: ${msg}`);
    }
  }

  state.message = `Sync complete: ${channels.length.toLocaleString()} channels`;
  if (state.programCount > 0) {
    state.message += `, ${state.programCount.toLocaleString()} programs`;
  }
}

// ---------- Main sync entry point ----------

function hasSourceConfigured(): boolean {
  const inputMode = getConfig('input_mode', 'manual');
  if (inputMode === 'xtream') return !!getXtreamConfig();
  return !!getManualUrls();
}

export async function sync(): Promise<void> {
  if (state.isSyncing) return;

  if (!hasSourceConfigured()) {
    state.phase = 'error';
    state.message = 'No source configured';
    logger.warn('Sync aborted: no source configured');
    return;
  }

  abortController = new AbortController();
  const { signal } = abortController;
  state.isSyncing = true;

  try {
    const inputMode = getConfig('input_mode', 'manual');
    if (inputMode === 'xtream') {
      await syncXtream(signal);
    } else {
      await syncManual(signal);
    }

    if (!signal.aborted) {
      const now = Date.now();
      state.lastSyncTime = now;
      state.phase = 'done';
      setConfig('last_sync_time', String(now));
    }
  } catch (err) {
    if (signal.aborted) {
      state.phase = 'idle';
      state.message = 'Sync cancelled';
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    state.phase = 'error';
    state.message = `Sync failed: ${msg}`;
    logger.error(`Sync failed: ${msg}`);
  } finally {
    state.isSyncing = false;
    abortController = null;
    scheduleNext();
  }
}

export function cancelSync(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  state.isSyncing = false;
  state.phase = 'idle';
  state.message = 'Sync cancelled';
  logger.info('Sync cancelled');
}

function getIntervalMs(): number | null {
  const interval = getConfig('sync_interval', '24h');
  switch (interval) {
    case '6h': return 6 * 60 * 60 * 1000;
    case '12h': return 12 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function scheduleNext(): void {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

  const intervalMs = getIntervalMs();
  if (!intervalMs) return;

  syncTimer = setTimeout(() => { sync(); }, intervalMs);
  logger.info(`Next sync scheduled in ${intervalMs / 3600000}h`);
}

export function startupSync(): void {
  if (!hasSourceConfigured()) return;

  const interval = getConfig('sync_interval', '24h');
  const lastSync = parseInt(getConfig('last_sync_time', '0'), 10);
  const now = Date.now();

  if (interval === 'startup' || lastSync === 0) {
    logger.info('Running startup sync...');
    sync();
  } else {
    const intervalMs = getIntervalMs();
    if (intervalMs && (now - lastSync) >= intervalMs) {
      logger.info('Sync interval elapsed, syncing...');
      sync();
    } else {
      state.channelCount = getChannelCount();
      state.programCount = getProgramCount();
      state.categoryCount = getCategoryCount();
      scheduleNext();
    }
  }

  // If we have no cached streams but have categories, start a background crawl
  const inputMode = getConfig('input_mode', 'manual');
  if (inputMode === 'xtream') {
    const lastCrawl = parseInt(getConfig('last_crawl_time', '0'), 10);
    const channelCount = getChannelCount();
    if (channelCount === 0 || (now - lastCrawl) > 24 * 60 * 60 * 1000) {
      // No streams cached or crawl is stale — start background crawl
      logger.info('Starting background stream crawl (no cached streams or crawl stale)...');
      setTimeout(() => startCrawl(), 5000); // Delay 5s to let startup finish
    } else {
      logger.info(`Streams cached (${channelCount}), last crawl ${((now - lastCrawl) / 3600000).toFixed(1)}h ago`);
    }
    scheduleNightlyCrawl();
  }
}

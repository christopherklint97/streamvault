import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';

function setStreamSocketOpts(res: import('express').Response): void {
  // Disable Nagle so writes flush immediately. Reduces small-write latency
  // under high throughput (4K bitrates push lots of TCP segments).
  const sock = res.socket as Socket | null;
  if (sock && typeof sock.setNoDelay === 'function') {
    try { sock.setNoDelay(true); } catch { /* ignore */ }
  }
}
import {
  getChannels, getChannelById, getChannelsByIds, getChannelsByGroup, getChannelCount, getChannelCountByGroup, getGroups, getRegions,
  getPrograms, getProgramsByChannelIds, getProgramsByChannel, saveProgramsForChannels,
  getProgramByAiringKey, getProgramByLegacyIdentity,
  getConfig, setConfig,
  getCategories, getCategoryByName, getContentTypeCounts,
  saveChannelsForCategory, markCategoryFetched,
  searchChannelsByName, getChannelCountByContentType,
  getChannelsByContentTypeCursor, getChannelsByGroupCursor,
  insertRecording, insertRecordingForAiring, updateRecording, deleteRecording, getRecording, getRecordings,
  getRecordingsByRuleId,
  getCommercialSegments, queueCommercialAnalysis, replaceCommercialSegmentsIfIdle,
  insertRecordingRule, updateRecordingRule, deleteRecordingRule, getRecordingRules, getRecordingRule,
  markRecordingRuleCadenceRetry,
  closeDatabase, backupDatabaseIfDue, getDatabaseHealth,
} from './db.js';
import type { DBRecording, DBRecordingRule } from './db.js';
import { getStatus, sync, cancelSync, startupSync, startCrawl, cancelCrawl } from './sync.js';
import { fetchXtreamStreamsByCategory, fetchXtreamShortEpg, fetchAllCategoryStreams, fetchXtreamSeriesInfo, fetchXtreamVodInfo } from './xtream.js';
import { createOnDemandEpg } from './on-demand-epg.js';
import type { XtreamConfig } from './xtream.js';
import { logger } from './logger.js';
import { requestStream, pickHeader, VLC_HEADERS } from './stream-utils.js';
import { prewarmUpstream } from './http-agent.js';
import {
  startRecording,
  stopRecording,
  stopAllRecordings,
  cancelRecording,
  deleteRecordingFile,
  getRecordingFilePath,
  getRecordingMasterFilePath,
  getFinalizationProgress,
  recoverRecordings,
  enforceRuleRetention,
  reconcileRecordOnceRule,
  withRuleRetentionLock,
} from './recorder.js';
import { startScheduler, stopScheduler, getSchedulerStatus, reconcileRecordingRule } from './recording-scheduler.js';
import {
  isCommercialAnalysisAvailable,
  notifyCommercialAnalysisQueued,
  startCommercialAnalysisWorker,
  stopCommercialAnalysisWorker,
} from './commercial-analysis-worker.js';
import {
  deriveProgramAiringKey,
  mapCommercialSegmentsResponse,
  mapRecordingForApi,
  parseBooleanConfig,
  validateCommercialSegmentReplacement,
  validateCommercialSkipOverride,
  validateFromProgramLookup,
  validateRecordingRulePayload,
  versionRecordingRuleUpdates,
} from './recording-api.js';
import { matchProgramTitle } from './schedule-reconciliation.js';
import { rewriteHlsManifest } from './hls.js';
import { buildFragmentedMp4Args } from './vod-remux.js';
import { buildBrowserCompatibleVideoArgs } from './browser-transcode.js';
import { buildIosHlsArgs, iosHlsContentType } from './ios-hls.js';
import { IOS_HLS_IDLE_TIMEOUT_MS, findReusableIosHlsSession, iosHlsProcessExitState, iosHlsSessionKey, iosHlsSessionLimitReason, selectIosHlsSessionsToRetire } from './ios-hls-sessions.js';
import { createIosHlsAuthorizationLimiter, createIosHlsTicket, sanitizeFfmpegMessage, verifyIosHlsTicket } from './ios-hls-security.js';
import { selectIosVodFallback } from './ios-vod.js';
import {
  SUBTITLE_EXTRACT_TIMEOUT_MS,
  SUBTITLE_PROBE_TIMEOUT_MS,
  SUBTITLE_PROCESS_OUTPUT_LIMIT,
  appendBoundedProcessOutput,
  buildSubtitleExtractArgs,
  buildSubtitleProbeArgs,
  createSubtitleProcessLimiters,
  createSubtitleRequestLimiter,
  isSubtitleClientDisconnected,
  parseSubtitleProbe,
  parseSubtitleStart,
  type ProbedSubtitleTrack,
} from './subtitles.js';
import { parseByteRange } from './ranges.js';
import {
  allowedProxyHostsFromConfig,
  canAccessRecordingStream,
  createRecordingPlaybackTicket,
  maskConfigResponse,
  normalizeAllowedOrigins,
  requireAuth,
  validateExternalHttpUrl,
  validateSourceHttpUrl,
  validateXtreamServerUrl,
} from './security.js';
import { isDatabaseCorruptionError, stopDatabaseBackupWorker } from './db-lifecycle.js';
import {
  ConcurrentStreamLimiter,
  LIVE_MPEG_TS_CONTENT_TYPE,
  buildLiveMpegTsArgs,
  liveFfmpegExitAction,
  selectLivePipeline,
} from './live-stream.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const IOS_HLS_ROOT = path.join('/tmp', 'streamvault-ios-hls');
const IOS_HLS_CLEANUP_INTERVAL_MS = 30_000;
const IOS_HLS_MAX_LIFETIME_MS = 4 * 60 * 60_000;
const IOS_HLS_MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024;
const IOS_HLS_TICKET_TTL_MS = 30_000;
const MAX_IOS_HLS_SESSIONS = 2;
const liveAudioTranscodes = new ConcurrentStreamLimiter(2);
const iosHlsTicketSecret = randomBytes(32).toString('hex');
const iosHlsTicketNonces = new Map<string, number>();
const iosHlsAuthorizationLimiter = createIosHlsAuthorizationLimiter();
type IosHlsSession = {
  directory: string;
  process: ReturnType<typeof spawn>;
  channelId: string;
  key: string;
  state: 'running' | 'complete' | 'failed';
  createdAt: number;
  expiresAt: number;
};
const iosHlsSessions = new Map<string, IosHlsSession>();

function retireIosHlsSession(sessionId: string, reason: string): void {
  const session = iosHlsSessions.get(sessionId);
  if (!session) return;
  iosHlsSessions.delete(sessionId);
  if (!session.process.killed) session.process.kill('SIGKILL');
  fs.rmSync(session.directory, { recursive: true, force: true });
  logger.info(`iOS HLS session retired: ${sessionId} (${reason})`);
}

function scheduleIosHlsCleanup(sessionId: string): void {
  setTimeout(() => {
    const session = iosHlsSessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    if (session.expiresAt <= now) {
      retireIosHlsSession(sessionId, 'idle');
      return;
    }
    let storageBytes = 0;
    try {
      for (const file of fs.readdirSync(session.directory)) {
        storageBytes += fs.statSync(path.join(session.directory, file)).size;
      }
    } catch { /* a concurrent retirement already removed the directory */ }
    const limitReason = iosHlsSessionLimitReason(
      session,
      now,
      storageBytes,
      IOS_HLS_MAX_LIFETIME_MS,
      IOS_HLS_MAX_STORAGE_BYTES,
    );
    if (limitReason) {
      retireIosHlsSession(sessionId, limitReason);
      return;
    }
    scheduleIosHlsCleanup(sessionId);
  }, IOS_HLS_CLEANUP_INTERVAL_MS).unref();
}

function parseIntegerQuery(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

const allowedOrigins = normalizeAllowedOrigins(process.env.STREAMVAULT_ALLOWED_ORIGINS);
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true,
}));
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (_req, res) => {
  const database = getDatabaseHealth();
  res.status(database.ok ? 200 : 503).json({
    ok: database.ok,
    service: 'streamvault',
    database: database.ok ? 'ok' : 'corrupt',
    ...(database.error ? { error: database.error } : {}),
    time: Date.now(),
  });
});

// ---------- Helper: get Xtream config ----------

function getXtreamConfig(): XtreamConfig | null {
  const server = getConfig('xtream_server');
  const username = getConfig('xtream_username');
  const password = getConfig('xtream_password');
  if (!server || !username || !password) return null;
  return { server, username, password };
}

function validateProxySourceUrl(rawUrl: string) {
  const xtreamServer = getConfig('xtream_server');
  return validateSourceHttpUrl(rawUrl, xtreamServer, allowedProxyHostsFromConfig(xtreamServer, process.env.STREAMVAULT_PROXY_ALLOWED_HOSTS));
}

function allowUpstreamRedirect(url: string): boolean {
  return validateSourceHttpUrl(url, getConfig('xtream_server')).ok;
}

const categoryRefreshes = new Map<string, Promise<void>>();
const CATEGORY_REFRESH_MS = 24 * 60 * 60 * 1000;

async function refreshCategoryForBrowse(group: string | undefined, inputMode: string): Promise<void> {
  if (!group || group === 'All' || inputMode !== 'xtream') return;
  const category = getCategoryByName(group);
  if (!category || (category.fetched_at && Date.now() - category.fetched_at < CATEGORY_REFRESH_MS)) return;

  let refresh = categoryRefreshes.get(category.id);
  if (!refresh) {
    const config = getXtreamConfig();
    if (!config) return;
    logger.info(`Refreshing category "${group}" (${category.id})`);
    refresh = fetchXtreamStreamsByCategory(config, category.id, category.name)
      .then(channels => {
        saveChannelsForCategory(category.id, channels);
        markCategoryFetched(category.id, channels.length);
        logger.info(`Category "${group}" refreshed: ${channels.length} streams`);
      })
      .catch(error => {
        logger.error(`Category "${group}" refresh failed: ${error instanceof Error ? error.message : error}`);
      })
      .finally(() => { categoryRefreshes.delete(category.id); });
    categoryRefreshes.set(category.id, refresh);
  }
  // First visit needs data before responding; later visits can use cached data.
  if (!category.fetched_at) await refresh;
}

// ---------- Categories ----------

app.get('/api/categories', (req, res) => {
  const contentType = req.query.type as string | undefined;
  const categories = getCategories(contentType);
  res.json({ categories });
});

// ---------- Channels ----------

app.get('/api/channels', async (req, res) => {
  const group = req.query.group as string | undefined;
  const limit = parseIntegerQuery(req.query.limit, 1, 200);
  const cursorSort = parseIntegerQuery(req.query.cursorSort, 0);
  const cursorName = req.query.cursorName as string | undefined;
  if (limit === null || cursorSort === null || (cursorName !== undefined && cursorSort === undefined) || (cursorSort !== undefined && cursorName === undefined)) {
    res.status(400).json({ error: 'Invalid pagination parameters' });
    return;
  }
  const inputMode = getConfig('input_mode', 'manual');

  await refreshCategoryForBrowse(group, inputMode);

  // Return channels from DB (with optional pagination)
  let dbChannels;
  let total: number;
  if (group && group !== 'All') {
    dbChannels = getChannelsByGroup(group, limit, cursorSort, cursorName);
    total = limit ? getChannelCountByGroup(group) : dbChannels.length;
  } else {
    dbChannels = getChannels(limit, cursorSort, cursorName);
    total = limit ? getChannelCount() : dbChannels.length;
  }

  const channels = dbChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
  }));

  // Groups come from categories in xtream mode, from channels in manual mode
  let groups: string[];
  const contentTypeCounts: Record<string, number> = {};
  if (inputMode === 'xtream') {
    const cats = getCategories();
    groups = ['All', ...cats.map(c => c.name)];
    for (const c of cats) {
      contentTypeCounts[c.content_type] = (contentTypeCounts[c.content_type] || 0) + 1;
    }
  } else {
    groups = ['All', ...getGroups()];
    const counts = getContentTypeCounts();
    Object.assign(contentTypeCounts, counts);
  }

  const regions = ['All', ...getRegions()];
  // Include cursor for next page (last item's sort_order + name)
  const lastChannel = dbChannels[dbChannels.length - 1];
  const nextCursor = lastChannel && limit && dbChannels.length === limit
    ? { sort: lastChannel.sort_order ?? 0, name: lastChannel.name }
    : null;
  res.json({ channels, total, groups, regions, contentTypeCounts, nextCursor });
});

// ---------- Batch fetch channels by IDs ----------

app.post('/api/channels/by-ids', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.json({ channels: [] });
    return;
  }
  // Cap at 200 to avoid huge queries
  const capped = ids.slice(0, 200);
  const dbChannels = getChannelsByIds(capped);
  const channels = dbChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
  }));
  res.json({ channels });
});

// ---------- Browse (lightweight, paginated by content type) ----------

app.get('/api/browse', async (req, res) => {
  const contentType = req.query.type as string | undefined;
  const group = req.query.group as string | undefined;
  const requestedLimit = parseIntegerQuery(req.query.limit, 1, 200);
  if (requestedLimit === null) {
    res.status(400).json({ error: 'Invalid limit' });
    return;
  }
  const limit = requestedLimit ?? 20;
  const after = req.query.after as string | undefined; // cursor: serialized sort key + name
  if (after) {
    try {
      const cursor = JSON.parse(after) as { a?: unknown; s?: unknown; n?: unknown };
      const sortValue = contentType === 'movies' || contentType === 'series' ? cursor.a : cursor.s;
      if (!cursor || typeof cursor !== 'object' || typeof sortValue !== 'number' || typeof cursor.n !== 'string') {
        throw new Error('invalid cursor');
      }
    } catch {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
  }
  const inputMode = getConfig('input_mode', 'manual');

  let dbChannels;
  let total: number;

  if (group && group !== 'All') {
    await refreshCategoryForBrowse(group, inputMode);
    dbChannels = getChannelsByGroupCursor(group, limit, after, contentType);
    total = getChannelCountByGroup(group);
  } else if (contentType) {
    dbChannels = getChannelsByContentTypeCursor(contentType, limit, after);
    total = getChannelCountByContentType(contentType);
  } else {
    res.json({ channels: [], total: 0, nextCursor: null });
    return;
  }

  const channels = dbChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
  }));

  // Build cursor based on content type sort strategy
  const lastItem = dbChannels[dbChannels.length - 1];
  let nextCursor: string | null = null;
  if (lastItem && dbChannels.length === limit) {
    const effectiveType = lastItem.content_type || contentType;
    if (effectiveType === 'movies' || effectiveType === 'series') {
      nextCursor = JSON.stringify({ a: lastItem.added ?? 0, n: lastItem.name });
    } else {
      nextCursor = JSON.stringify({ s: lastItem.sort_order ?? 0, n: lastItem.name });
    }
  }

  res.json({ channels, total, nextCursor });
});

// ---------- Search ----------

// Track ongoing fetch-all operations to avoid duplicates
const fetchAllInProgress = new Set<string>();

app.get('/api/search', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  const contentType = req.query.type as string | undefined;
  const group = req.query.group as string | undefined;
  const inputMode = getConfig('input_mode', 'manual');

  if (!q) {
    res.json({ channels: [], fetching: false });
    return;
  }

  // If xtream mode and no channels cached for this content type, fetch all categories first
  let fetching = false;
  if (inputMode === 'xtream' && contentType) {
    const cachedCount = getChannelCountByContentType(contentType);
    if (cachedCount === 0 && !fetchAllInProgress.has(contentType)) {
      // Trigger background fetch of all categories for this content type
      fetching = true;
      fetchAllInProgress.add(contentType);
      const config = getXtreamConfig();
      if (config) {
        const cats = getCategories(contentType);
        const unfetchedCats = cats.filter(c => !c.fetched_at);
        if (unfetchedCats.length > 0) {
          // Fire and forget — results will be available on next search
          fetchAllCategoryStreams(config, unfetchedCats, (catId, channels) => {
            saveChannelsForCategory(catId, channels);
            markCategoryFetched(catId, channels.length);
          }).finally(() => {
            fetchAllInProgress.delete(contentType);
            logger.info(`Background fetch complete for ${contentType}`);
          });
        } else {
          fetchAllInProgress.delete(contentType);
          fetching = false;
        }
      } else {
        fetchAllInProgress.delete(contentType);
        fetching = false;
      }
    } else if (fetchAllInProgress.has(contentType)) {
      fetching = true;
    }
  }

  // Search what we have cached
  const dbChannels = searchChannelsByName(q, contentType, group);
  const channels = dbChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
  }));

  res.json({ channels, fetching });
});

// Fetch all streams for a content type (iterates through categories)
app.post('/api/fetch-all', async (req, res) => {
  const contentType = req.body.contentType as string;
  if (!contentType) {
    res.status(400).json({ error: 'contentType required' });
    return;
  }

  if (fetchAllInProgress.has(contentType)) {
    res.json({ ok: true, message: 'Already fetching' });
    return;
  }

  const config = getXtreamConfig();
  if (!config) {
    res.status(400).json({ error: 'Xtream not configured' });
    return;
  }

  const cats = getCategories(contentType);
  const unfetchedCats = cats.filter(c => !c.fetched_at);

  if (unfetchedCats.length === 0) {
    res.json({ ok: true, message: 'All categories already cached' });
    return;
  }

  fetchAllInProgress.add(contentType);
  res.json({ ok: true, message: `Fetching ${unfetchedCats.length} categories` });

  fetchAllCategoryStreams(config, unfetchedCats, (catId, channels) => {
    saveChannelsForCategory(catId, channels);
    markCategoryFetched(catId, channels.length);
  }).finally(() => {
    fetchAllInProgress.delete(contentType);
    logger.info(`Fetch-all complete for ${contentType}`);
  });
});

// ---------- Programs ----------

app.get('/api/programs', (req, res) => {
  const from = req.query.from === undefined ? undefined : Number(req.query.from);
  const to = req.query.to === undefined ? undefined : Number(req.query.to);
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
    res.status(400).json({ error: 'Invalid time range' });
    return;
  }
  const programs = getPrograms(from, to).map(p => ({
    channelId: p.channel_id,
    title: p.title,
    description: p.description,
    start: new Date(p.start_time).toISOString(),
    stop: new Date(p.stop_time).toISOString(),
    category: p.category,
  }));
  res.json({ programs });
});

// ---------- Batch EPG (for channel list view) ----------

const onDemandEpg = createOnDemandEpg({
  read: getProgramsByChannelIds,
  fetch: fetchXtreamShortEpg,
  save: saveProgramsForChannels,
  getConfig: getXtreamConfig,
  warn: message => logger.warn(message),
});

app.get('/api/epg/batch', (req, res) => {
  const idsParam = req.query.ids as string | undefined;
  if (!idsParam) {
    res.json({ programs: {} });
    return;
  }
  const channelIds = idsParam.split(',').slice(0, 100); // cap at 100
  const now = Date.now();
  const from = req.query.from === undefined ? now - 2 * 60 * 60 * 1000 : Number(req.query.from);
  const to = req.query.to === undefined ? now + 6 * 60 * 60 * 1000 : Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: 'Invalid time range' });
    return;
  }
  const dbPrograms = onDemandEpg.get(channelIds, from, to);

  // Group by channel ID
  const grouped: Record<string, Array<{ channelId: string; title: string; description: string; start: string; stop: string }>> = {};
  for (const p of dbPrograms) {
    if (!grouped[p.channel_id]) grouped[p.channel_id] = [];
    grouped[p.channel_id].push({
      channelId: p.channel_id,
      title: p.title,
      description: p.description,
      start: new Date(p.start_time).toISOString(),
      stop: new Date(p.stop_time).toISOString(),
    });
  }
  res.json({ programs: grouped });
});

// ---------- EPG for single channel (full schedule) ----------

app.get('/api/epg/channel/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const from = req.query.from === undefined ? undefined : Number(req.query.from);
  const to = req.query.to === undefined ? undefined : Number(req.query.to);
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
    res.status(400).json({ error: 'Invalid time range' });
    return;
  }
  const dbPrograms = from !== undefined && to !== undefined
    ? onDemandEpg.get([channelId], from, to)
    : getProgramsByChannel(channelId, from, to);
  const programs = dbPrograms.map(p => ({
    channelId: p.channel_id,
    title: p.title,
    description: p.description,
    start: new Date(p.start_time).toISOString(),
    stop: new Date(p.stop_time).toISOString(),
    category: p.category,
  }));
  res.json({ programs });
});

// ---------- On-demand EPG (Xtream short EPG) ----------

app.get('/api/epg/:streamId', async (req, res) => {
  const streamId = parseInt(req.params.streamId, 10);
  if (isNaN(streamId)) {
    res.status(400).json({ error: 'Invalid stream ID' });
    return;
  }

  const config = getXtreamConfig();
  if (!config) {
    res.json({ programs: [] });
    return;
  }

  try {
    const programs = await fetchXtreamShortEpg(config, [streamId], 'live_');
    // Also save to DB for future batch queries
    if (programs.length > 0) {
      saveProgramsForChannels(programs);
    }
    res.json({
      programs: programs.map(p => ({
        channelId: p.channel_id,
        title: p.title,
        description: p.description,
        start: new Date(p.start_time).toISOString(),
        stop: new Date(p.stop_time).toISOString(),
        category: p.category,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`EPG fetch failed for stream ${streamId}: ${msg}`);
    res.json({ programs: [] });
  }
});

// ---------- Series Info ----------

app.get('/api/series/:seriesId', async (req, res) => {
  const seriesId = parseInt(req.params.seriesId, 10);
  if (isNaN(seriesId)) {
    res.status(400).json({ error: 'Invalid series ID' });
    return;
  }

  const config = getXtreamConfig();
  if (!config) {
    res.status(400).json({ error: 'Xtream not configured' });
    return;
  }

  try {
    const info = await fetchXtreamSeriesInfo(config, seriesId);
    res.json(info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Series info fetch failed for ${seriesId}: ${msg}`);
    res.status(500).json({ error: `Failed to fetch series info: ${msg}` });
  }
});

// ---------- VOD Info ----------

app.get('/api/vod/:vodId', async (req, res) => {
  const vodId = parseInt(req.params.vodId, 10);
  if (isNaN(vodId)) {
    res.status(400).json({ error: 'Invalid VOD ID' });
    return;
  }

  const config = getXtreamConfig();
  if (!config) {
    res.status(400).json({ error: 'Xtream not configured' });
    return;
  }

  try {
    const info = await fetchXtreamVodInfo(config, vodId);
    res.json(info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`VOD info fetch failed for ${vodId}: ${msg}`);
    res.status(500).json({ error: `Failed to fetch VOD info: ${msg}` });
  }
});

// ---------- Client Logs ----------
// Receives logs from the frontend and outputs them to server stdout (→ Dozzle)

app.post('/api/client-logs', (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs)) {
    res.status(400).json({ error: 'logs array required' });
    return;
  }
  for (const entry of logs) {
    const { level, message, ts } = entry;
    const prefix = `${ts || new Date().toISOString()} [CLIENT:${(level || 'info').toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else if (level === 'warn') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
  res.json({ ok: true });
});

// ---------- Native Player Page ----------
// Serves a minimal HTML page with a <video> element for iOS Safari.
// Safari can't play raw MPEG-TS in a new tab, but <video> triggers the native player.

app.get('/api/player/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const channel = getChannelById(channelId);
  const title = channel?.name || channelId;
  // Build the stream URL with same logic as the stream proxy
  let streamSrc = `/api/stream/${encodeURIComponent(channelId)}`;
  if (!channel && req.query.url) {
    streamSrc += `?url=${encodeURIComponent(req.query.url as string)}`;
    if (req.query.type) streamSrc += `&type=${encodeURIComponent(req.query.type as string)}`;
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&"]/g, '')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;display:flex;align-items:center;justify-content:center;height:100vh;height:100dvh}
video{width:100%;height:100%;object-fit:contain}
</style>
</head><body>
<video src="${streamSrc}" autoplay playsinline controls controlslist="nodownload"></video>
</body></html>`);
});

// ---------- Subtitle discovery and browser WebVTT ----------

const SUBTITLE_PROBE_TTL_MS = 6 * 60 * 60_000;
const SUBTITLE_PROBE_OUTPUT_LIMIT = 2_000_000;
const subtitleProbeCache = new Map<string, { expiresAt: number; tracks: Promise<ProbedSubtitleTrack[]> }>();
const subtitleProcessLimiters = createSubtitleProcessLimiters();
const subtitleRequestLimiter = createSubtitleRequestLimiter();

class SubtitleCapacityError extends Error {}

type SubtitleSource = { cacheKey: string; inputUrl: string };

function subtitleSource(channelId: string, rawUrl: unknown, iosFallback = false): SubtitleSource | null {
  const requestedChannel = getChannelById(channelId);
  if (requestedChannel?.url && requestedChannel.content_type !== 'livetv') {
    const sourceChannel = iosFallback && requestedChannel.content_type === 'movies'
      ? selectIosVodFallback(
          requestedChannel,
          searchChannelsByName(requestedChannel.name.replace(/\s*\[4K\]\s*$/i, ''), 'movies'),
        )
      : requestedChannel;
    return {
      cacheKey: iosFallback ? `${channelId}:ios:${sourceChannel.id}` : channelId,
      inputUrl: `http://127.0.0.1:${PORT}/api/stream/${encodeURIComponent(sourceChannel.id)}`,
    };
  }
  if (!channelId.startsWith('episode_') || typeof rawUrl !== 'string') return null;
  const validation = validateProxySourceUrl(rawUrl);
  if (!validation.ok) return null;
  const sourcePath = `/api/stream/${encodeURIComponent(channelId)}?url=${encodeURIComponent(validation.url.toString())}&type=series`;
  return {
    cacheKey: `${channelId}:${validation.url.toString()}`,
    inputUrl: `http://127.0.0.1:${PORT}${sourcePath}`,
  };
}

function probeSubtitleTracks(source: SubtitleSource): Promise<ProbedSubtitleTrack[]> {
  const now = Date.now();
  const cached = subtitleProbeCache.get(source.cacheKey);
  if (cached && cached.expiresAt > now) return cached.tracks;
  if (cached) subtitleProbeCache.delete(source.cacheKey);

  const releaseProbeSlot = subtitleProcessLimiters.probes.acquire();
  if (!releaseProbeSlot) {
    return Promise.reject(new SubtitleCapacityError('Subtitle discovery capacity reached'));
  }

  const tracks = new Promise<ProbedSubtitleTrack[]>((resolve, reject) => {
    const ffprobe = spawn('ffprobe', buildSubtitleProbeArgs(source.inputUrl), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let processEnded = false;
    const releaseProcess = () => {
      if (processEnded) return;
      processEnded = true;
      releaseProbeSlot();
    };
    const finish = (error?: Error, value: ProbedSubtitleTrack[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      if (!ffprobe.killed) ffprobe.kill('SIGKILL');
      finish(new Error('Subtitle discovery timed out'));
    }, SUBTITLE_PROBE_TIMEOUT_MS);
    timer.unref();

    ffprobe.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const responseTooLarge = stdout.length + text.length > SUBTITLE_PROBE_OUTPUT_LIMIT;
      stdout = appendBoundedProcessOutput(stdout, text, SUBTITLE_PROBE_OUTPUT_LIMIT);
      if (responseTooLarge) {
        if (!ffprobe.killed) ffprobe.kill('SIGKILL');
        finish(new Error('Subtitle metadata response was too large'));
      }
    });
    ffprobe.stderr.on('data', (chunk) => {
      stderr = appendBoundedProcessOutput(stderr, chunk, SUBTITLE_PROCESS_OUTPUT_LIMIT);
    });
    ffprobe.on('error', (error) => {
      releaseProcess();
      finish(error);
    });
    ffprobe.on('close', (code) => {
      releaseProcess();
      if (settled) return;
      if (code !== 0) {
        finish(new Error(sanitizeFfmpegMessage(stderr.trim() || `ffprobe exited ${code}`)));
        return;
      }
      finish(undefined, parseSubtitleProbe(stdout));
    });
  });

  subtitleProbeCache.set(source.cacheKey, { expiresAt: now + SUBTITLE_PROBE_TTL_MS, tracks });
  tracks.catch(() => subtitleProbeCache.delete(source.cacheKey));
  while (subtitleProbeCache.size > 500) {
    const oldest = subtitleProbeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    subtitleProbeCache.delete(oldest);
  }
  return tracks;
}

app.get('/api/subtitles/:channelId', async (req, res) => {
  if (!subtitleRequestLimiter.allow(req.ip || req.socket.remoteAddress || 'unknown')) {
    res.set('Retry-After', '60').status(429).json({ error: 'Too many subtitle requests' });
    return;
  }
  const source = subtitleSource(req.params.channelId, req.query.url, req.query.ios === '1');
  if (!source) {
    res.status(404).json({ error: 'Subtitle source not found' });
    return;
  }
  try {
    const tracks = await probeSubtitleTracks(source);
    if (isSubtitleClientDisconnected(req, res)) return;
    res.set('Cache-Control', 'no-store').json({ tracks });
  } catch (error) {
    if (isSubtitleClientDisconnected(req, res)) return;
    logger.warn(`Subtitle discovery failed for ${req.params.channelId}: ${error instanceof Error ? error.message : error}`);
    if (error instanceof SubtitleCapacityError) {
      res.set('Retry-After', '5').status(503).json({ error: 'Subtitle discovery capacity reached' });
    } else {
      res.status(502).json({ error: 'Subtitle discovery failed' });
    }
  }
});

app.get('/api/subtitles/:channelId/:streamIndex.vtt', async (req, res) => {
  if (!subtitleRequestLimiter.allow(req.ip || req.socket.remoteAddress || 'unknown')) {
    res.set('Retry-After', '60').status(429).json({ error: 'Too many subtitle requests' });
    return;
  }

  const streamIndex = parseIntegerQuery(req.params.streamIndex, 0, 999);
  const startSeconds = parseSubtitleStart(req.query.start);
  const source = subtitleSource(req.params.channelId, req.query.url, req.query.ios === '1');
  if (streamIndex === null || streamIndex === undefined || startSeconds === null || !source) {
    res.status(400).json({ error: 'Invalid subtitle request' });
    return;
  }

  let clientClosed = false;
  let ff: ReturnType<typeof spawn> | null = null;
  let extractionTimer: ReturnType<typeof setTimeout> | null = null;
  let responseHandled = false;
  let releaseExtractionSlot: (() => void) | null = null;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseExtractionSlot?.();
  };
  const markResponseHandled = () => {
    if (responseHandled) return false;
    responseHandled = true;
    if (extractionTimer) clearTimeout(extractionTimer);
    return true;
  };

  // Register before awaiting the shared probe so a disconnected request can
  // never continue into a new FFmpeg extraction process.
  res.on('close', () => {
    if (res.writableEnded) return;
    clientClosed = true;
    markResponseHandled();
    if (ff && !ff.killed) ff.kill('SIGKILL');
  });

  try {
    const tracks = await probeSubtitleTracks(source);
    if (isSubtitleClientDisconnected(req, res) || clientClosed) return;
    if (!tracks.some((track) => track.index === streamIndex)) {
      res.status(404).json({ error: 'Subtitle track not found' });
      return;
    }
  } catch (error) {
    if (isSubtitleClientDisconnected(req, res) || clientClosed) return;
    if (error instanceof SubtitleCapacityError) {
      res.set('Retry-After', '5').status(503).json({ error: 'Subtitle discovery capacity reached' });
    } else {
      res.status(502).json({ error: 'Subtitle discovery failed' });
    }
    return;
  }

  if (isSubtitleClientDisconnected(req, res) || clientClosed) return;
  releaseExtractionSlot = subtitleProcessLimiters.extractions.acquire();
  if (!releaseExtractionSlot) {
    res.set('Retry-After', '5').status(503).json({ error: 'Subtitle extraction capacity reached' });
    return;
  }

  try {
    ff = spawn('ffmpeg', buildSubtitleExtractArgs(source.inputUrl, streamIndex, startSeconds || 0), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    releaseSlot();
    logger.warn(`Subtitle extraction failed for ${req.params.channelId}: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: 'Subtitle extraction failed' });
    return;
  }

  if (!ff || !ff.stdout || !ff.stderr) {
    if (ff && !ff.killed) ff.kill('SIGKILL');
    releaseSlot();
    res.status(500).json({ error: 'Subtitle extraction failed' });
    return;
  }
  const extractionProcess = ff;
  const subtitleStdout = ff.stdout;
  const subtitleStderr = ff.stderr;
  let stderr = '';
  res.status(200);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  setStreamSocketOpts(res);

  extractionTimer = setTimeout(() => {
    if (!markResponseHandled()) return;
    logger.warn(`Subtitle extraction timed out for ${req.params.channelId}`);
    if (ff && !ff.killed) ff.kill('SIGKILL');
    if (!res.headersSent) res.status(504).json({ error: 'Subtitle extraction timed out' });
    else res.destroy(new Error('Subtitle extraction timed out'));
  }, SUBTITLE_EXTRACT_TIMEOUT_MS);
  extractionTimer.unref();

  subtitleStderr.on('data', (chunk) => {
    stderr = appendBoundedProcessOutput(stderr, chunk, SUBTITLE_PROCESS_OUTPUT_LIMIT);
  });
  subtitleStdout.on('error', () => {});
  subtitleStdout.pipe(res, { end: false });
  extractionProcess.on('error', (error) => {
    releaseSlot();
    if (!markResponseHandled()) return;
    logger.warn(`Subtitle extraction failed for ${req.params.channelId}: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Subtitle extraction failed' });
    else res.destroy(error);
  });
  extractionProcess.on('close', (code, signal) => {
    releaseSlot();
    if (!markResponseHandled() || clientClosed) return;
    if (code === 0) res.end();
    else {
      logger.warn(`Subtitle extraction exited for ${req.params.channelId}: code=${code} signal=${signal} ${sanitizeFfmpegMessage(stderr.trim())}`);
      if (!res.headersSent) res.status(502).json({ error: 'Subtitle extraction failed' });
      else res.destroy(new Error('Subtitle extraction failed'));
    }
  });
});

// ---------- Browser-compatible VOD remux ----------
// iOS Safari does not play provider MKV files directly. Remuxing the existing
// HEVC/AAC streams into fragmented MP4 preserves quality and avoids the CPU
// cost and latency of a transcode.
app.get('/api/remux/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const requestedChannel = getChannelById(channelId);
  if (!requestedChannel?.url || requestedChannel.content_type === 'livetv') {
    res.status(404).json({ error: 'VOD stream not found' });
    return;
  }

  // Prefer an identical non-4K edition on iPhone. It avoids a costly,
  // non-realtime transcode when the handset cannot decode the 4K HEVC source.
  const fallbackCandidates = searchChannelsByName(
    requestedChannel.name.replace(/\s*\[4K\]\s*$/i, ''),
    'movies'
  );
  const sourceChannel = selectIosVodFallback(requestedChannel, fallbackCandidates);
  if (sourceChannel.id !== requestedChannel.id) {
    logger.info(`VOD remux: iPhone fallback ${requestedChannel.id} → ${sourceChannel.id}`);
  }

  // Use the existing loopback stream proxy so the provider request retains
  // StreamVault's CDN-compatible headers and credential handling.
  const sourceUrl = `http://127.0.0.1:${PORT}/api/stream/${encodeURIComponent(sourceChannel.id)}`;
  const isHevc = /\[4K\]\s*$/i.test(sourceChannel.name);
  const ff = spawn('ffmpeg', buildFragmentedMp4Args(sourceUrl, isHevc), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  setStreamSocketOpts(res);

  ff.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) logger.warn(`VOD remux[${channelId}]: ${sanitizeFfmpegMessage(message)}`);
  });
  ff.on('error', (err) => {
    logger.error(`VOD remux spawn failed for ${channelId}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'VOD remux failed to start' });
  });
  ff.on('exit', (code, signal) => {
    logger.info(`VOD remux exited ${channelId} code=${code} signal=${signal}`);
  });
  ff.stdout.on('error', () => {});
  ff.stdout.pipe(res);

  req.on('close', () => {
    if (!ff.killed) ff.kill('SIGKILL');
  });
});

// ---------- Browser-compatible VOD transcode ----------
// Some providers package series episodes as MKV with legacy MPEG-4 Part 2
// video. Chromium can decode the MP3 audio but not that video, producing a
// black picture. Convert only browser VOD playback to H.264/AAC fMP4.
app.get('/api/transcode/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const channel = getChannelById(channelId);
  let sourcePath: string;

  if (channel?.url && channel.content_type !== 'livetv') {
    sourcePath = `/api/stream/${encodeURIComponent(channelId)}`;
  } else if (channelId.startsWith('episode_') && typeof req.query.url === 'string') {
    const validation = validateProxySourceUrl(req.query.url);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    sourcePath = `/api/stream/${encodeURIComponent(channelId)}?url=${encodeURIComponent(validation.url.toString())}&type=series`;
  } else {
    res.status(404).json({ error: 'VOD stream not found' });
    return;
  }

  const startSeconds = parseSubtitleStart(req.query.start);
  if (startSeconds === null) {
    res.status(400).json({ error: 'Invalid start time' });
    return;
  }

  const sourceUrl = `http://127.0.0.1:${PORT}${sourcePath}`;
  const ff = spawn('ffmpeg', buildBrowserCompatibleVideoArgs(sourceUrl, startSeconds || 0), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  setStreamSocketOpts(res);

  ff.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) logger.warn(`VOD transcode[${channelId}]: ${sanitizeFfmpegMessage(message)}`);
  });
  ff.on('error', (err) => {
    logger.error(`VOD transcode spawn failed for ${channelId}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'VOD transcode failed to start' });
  });
  ff.on('exit', (code, signal) => {
    logger.info(`VOD transcode exited ${channelId} code=${code} signal=${signal}`);
  });
  ff.stdout.on('error', () => {});
  ff.stdout.pipe(res);

  req.on('close', () => {
    if (!ff.killed) ff.kill('SIGKILL');
  });
});

// ---------- iPhone HLS fallback ----------
// iOS WebKit rejects some direct chunked fMP4 responses even when their H.264
// and AAC tracks are valid. Native HLS is its reliable streaming format.
app.get('/api/ios-hls-authorize/:channelId/index.m3u8', (req, res) => {
  const channelId = req.params.channelId;
  const contentType = iosHlsContentType(channelId, req.query.type);
  const startSeconds = parseSubtitleStart(req.query.start);
  if (!contentType || typeof req.query.url !== 'string' || startSeconds === null) {
    res.status(400).json({ error: 'Invalid iPhone HLS request' });
    return;
  }
  if (!iosHlsAuthorizationLimiter.allow(req.ip || req.socket.remoteAddress || 'unknown')) {
    res.set('Retry-After', '60').status(429).json({ error: 'Too many iPhone HLS starts' });
    return;
  }
  const validation = validateProxySourceUrl(req.query.url);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const now = Date.now();
  for (const [nonce, expiresAt] of iosHlsTicketNonces) {
    if (expiresAt < now) iosHlsTicketNonces.delete(nonce);
  }
  const expiresAt = now + IOS_HLS_TICKET_TTL_MS;
  const nonce = randomUUID();
  const ticket = createIosHlsTicket({
    channelId,
    sourceUrl: validation.url.toString(),
    contentType,
    startSeconds: startSeconds || 0,
  }, iosHlsTicketSecret, expiresAt, nonce);
  iosHlsTicketNonces.set(nonce, expiresAt);

  const params = new URLSearchParams({
    url: validation.url.toString(),
    type: contentType,
    ticket,
  });
  if (startSeconds) params.set('start', String(startSeconds));
  res.set('Cache-Control', 'no-store').redirect(302, `/api/ios-hls/${encodeURIComponent(channelId)}/index.m3u8?${params.toString()}`);
});

app.get('/api/ios-hls/:channelId/index.m3u8', (req, res) => {
  const channelId = req.params.channelId;
  const contentType = iosHlsContentType(channelId, req.query.type);
  if (!contentType || typeof req.query.url !== 'string') {
    res.status(404).json({ error: 'iPhone VOD source not found' });
    return;
  }
  const requestValidation = validateProxySourceUrl(req.query.url);
  if (!requestValidation.ok) {
    res.status(400).json({ error: requestValidation.error });
    return;
  }
  let sourceChannelId = channelId;
  let sourceUrlParam = requestValidation.url.toString();
  if (contentType === 'movies') {
    const requestedChannel = getChannelById(channelId);
    if (requestedChannel?.url) {
      const candidates = searchChannelsByName(requestedChannel.name.replace(/\s*\[4K\]\s*$/i, ''), 'movies');
      const fallback = selectIosVodFallback(requestedChannel, candidates);
      sourceChannelId = fallback.id;
      sourceUrlParam = fallback.url;
      if (fallback.id !== channelId) logger.info(`iOS HLS: iPhone fallback ${channelId} → ${fallback.id}`);
    }
  }
  const sourceValidation = validateProxySourceUrl(sourceUrlParam);
  if (!sourceValidation.ok) {
    res.status(400).json({ error: sourceValidation.error });
    return;
  }

  const startSeconds = parseSubtitleStart(req.query.start);
  if (startSeconds === null) {
    res.status(400).json({ error: 'Invalid start time' });
    return;
  }

  const existingSessionId = typeof req.query.session === 'string' ? req.query.session : undefined;
  if (existingSessionId) {
    const existing = iosHlsSessions.get(existingSessionId);
    if (!existing || existing.channelId !== channelId) {
      res.status(404).json({ error: 'iPhone stream session expired' });
      return;
    }
    existing.expiresAt = Date.now() + IOS_HLS_IDLE_TIMEOUT_MS;
    const existingPlaylist = path.join(existing.directory, 'index.m3u8');
    const startedAt = Date.now();
    const sendExistingPlaylist = () => {
      if (fs.existsSync(existingPlaylist)) {
        const playlist = fs.readFileSync(existingPlaylist, 'utf8')
          .replace(/(init\.mp4|segment-\d+\.m4s)/g, `/api/ios-hls-assets/${existingSessionId}/$1`);
        res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(playlist);
        return;
      }
      if (Date.now() - startedAt > 20_000) {
        res.status(504).json({ error: 'Timed out preparing iPhone stream' });
        return;
      }
      setTimeout(sendExistingPlaylist, 100);
    };
    sendExistingPlaylist();
    return;
  }

  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const ticketResult = verifyIosHlsTicket(ticket, {
    channelId,
    sourceUrl: requestValidation.url.toString(),
    contentType,
    startSeconds: startSeconds || 0,
  }, iosHlsTicketSecret);
  if (!ticketResult.valid || iosHlsTicketNonces.get(ticketResult.nonce) !== ticketResult.expiresAt) {
    res.status(401).json({ error: 'Invalid or expired iPhone HLS ticket' });
    return;
  }
  iosHlsTicketNonces.delete(ticketResult.nonce);

  const requestedStart = startSeconds || 0;
  const sessionKey = iosHlsSessionKey(channelId, sourceValidation.url.toString(), requestedStart);
  const reusableSessionId = findReusableIosHlsSession(iosHlsSessions, sessionKey);
  if (reusableSessionId) {
    const reusable = iosHlsSessions.get(reusableSessionId)!;
    reusable.expiresAt = Date.now() + IOS_HLS_IDLE_TIMEOUT_MS;
    const params = new URLSearchParams({
      url: requestValidation.url.toString(),
      type: contentType,
      session: reusableSessionId,
    });
    if (requestedStart) params.set('start', String(requestedStart));
    res.redirect(302, `/api/ios-hls/${encodeURIComponent(channelId)}/index.m3u8?${params.toString()}`);
    return;
  }

  const sessionId = randomUUID();
  const directory = path.join(IOS_HLS_ROOT, sessionId);
  const playlistPath = path.join(directory, 'index.m3u8');
  for (const staleSessionId of selectIosHlsSessionsToRetire(iosHlsSessions, channelId, MAX_IOS_HLS_SESSIONS)) {
    retireIosHlsSession(staleSessionId, 'superseded');
  }
  fs.mkdirSync(directory, { recursive: true });
  const sourcePath = `/api/stream/${encodeURIComponent(sourceChannelId)}?url=${encodeURIComponent(sourceValidation.url.toString())}&type=${contentType}`;
  const sourceUrl = `http://127.0.0.1:${PORT}${sourcePath}`;
  const ff = spawn('ffmpeg', buildIosHlsArgs(sourceUrl, playlistPath, startSeconds || 0), { stdio: ['ignore', 'ignore', 'pipe'] });
  iosHlsSessions.set(sessionId, {
    directory,
    process: ff,
    channelId,
    key: sessionKey,
    state: 'running',
    createdAt: Date.now(),
    expiresAt: Date.now() + IOS_HLS_IDLE_TIMEOUT_MS,
  });
  scheduleIosHlsCleanup(sessionId);
  ff.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) logger.warn(`iOS HLS[${channelId}]: ${sanitizeFfmpegMessage(message)}`);
  });
  ff.on('error', (err) => {
    logger.error(`iOS HLS spawn failed for ${channelId}: ${err.message}`);
    const active = iosHlsSessions.get(sessionId);
    if (active?.process === ff) {
      active.state = 'failed';
      retireIosHlsSession(sessionId, 'ffmpeg-error');
    }
  });
  ff.on('exit', (code, signal) => {
    const active = iosHlsSessions.get(sessionId);
    if (active?.process !== ff) return;
    active.state = iosHlsProcessExitState(code, signal);
    if (active.state === 'failed') {
      retireIosHlsSession(sessionId, `ffmpeg-exit-${code ?? signal ?? 'unknown'}`);
    } else {
      logger.info(`iOS HLS session complete: ${sessionId}`);
    }
  });

  const playlistUrl = `/api/ios-hls/${encodeURIComponent(channelId)}/index.m3u8?url=${encodeURIComponent(requestValidation.url.toString())}&type=${contentType}&session=${encodeURIComponent(sessionId)}${startSeconds ? `&start=${startSeconds}` : ''}`;
  res.redirect(302, playlistUrl);
});

app.get('/api/ios-hls-assets/:sessionId/:asset', (req, res) => {
  const session = iosHlsSessions.get(req.params.sessionId);
  const asset = req.params.asset;
  if (!session || !/^(init\.mp4|segment-\d+\.m4s)$/.test(asset)) {
    res.status(404).end();
    return;
  }
  session.expiresAt = Date.now() + IOS_HLS_IDLE_TIMEOUT_MS;
  const filePath = path.join(session.directory, asset);
  if (!fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.type(asset.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment').set('Cache-Control', 'no-store').sendFile(filePath);
});

// ---------- Stream Proxy ----------
// Proxies stream URLs through the server so mobile clients don't need
// direct access to the Xtream server (avoids CORS and network issues).

app.get('/api/stream/:channelId', async (req, res) => {
  const channelId = req.params.channelId;
  const channel = getChannelById(channelId);

  // For episodes (not in DB), accept URL as query parameter
  let streamUrl: string;
  let contentType: string;
  if (channel && channel.url) {
    streamUrl = channel.url;
    contentType = channel.content_type;
  } else if (req.query.url) {
    const validation = validateProxySourceUrl(req.query.url as string);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    streamUrl = validation.url.toString();
    contentType = (req.query.type as string) || 'series';
    logger.info(`Stream proxy: using URL param for ${channelId}`);
  } else {
    logger.warn(`Stream proxy: channel ${channelId} not found or has no URL`);
    res.status(404).json({ error: 'Channel not found' });
    return;
  }
  const channelName = channel?.name || channelId;
  logger.info(`Stream proxy: ${channelId} "${channelName}" type=${contentType} → upstream`);

  const isLive = contentType === 'livetv';

  try {
    const upstreamHeaders: Record<string, string> = { ...VLC_HEADERS };
    // Forward Range header for VOD (seeking), skip for live streams
    if (req.headers.range && !isLive) {
      upstreamHeaders['Range'] = req.headers.range;
      logger.info(`Stream proxy: forwarding Range header: ${req.headers.range}`);
    }

    // Use undici.request directly: returns a Node Readable so we skip the
    // Web→Node stream conversion overhead, and rides the shared keepalive
    // pool (huge win for VOD seeks). Live has no body timeout; VOD gets a
    // 30s headers timeout.
    const upstream = await requestStream(
      streamUrl,
      upstreamHeaders,
      10,
      isLive ? 30_000 : 30_000,
      allowUpstreamRedirect,
    );

    logger.info('Stream proxy: upstream redirect resolved');
    const upstreamCT = pickHeader(upstream.headers, 'content-type');
    const upstreamCL = pickHeader(upstream.headers, 'content-length');
    logger.info(`Stream proxy: upstream responded ${upstream.statusCode}, content-type=${upstreamCT}, content-length=${upstreamCL}`);

    // Detect Cloudflare abuse page (tiny response masquerading as video)
    const cl = upstreamCL ? parseInt(upstreamCL, 10) : null;
    if (cl && cl < 100_000 && !isLive) {
      const finalHost = new URL(upstream.finalUrl).hostname;
      if (finalHost.includes('cloudflare') || finalHost.includes('abuse')) {
        logger.error(`Stream proxy: Cloudflare blocked stream for ${channelId} (redirected to ${finalHost}, ${cl} bytes)`);
        upstream.body.on('error', () => {});
        upstream.body.dump().catch(() => {});
        res.status(502).json({ error: 'Stream blocked by CDN protection. The content provider may be restricting access.' });
        return;
      }
    }

    if (upstream.statusCode >= 400) {
      logger.error(`Stream proxy: upstream error ${upstream.statusCode} for ${channelId}`);
      upstream.body.on('error', () => {});
      upstream.body.dump().catch(() => {});
      res.status(upstream.statusCode).json({ error: `Upstream error: ${upstream.statusCode}` });
      return;
    }

    // Reject HTML responses — upstream returned an error page instead of video
    if (upstreamCT && upstreamCT.includes('text/html')) {
      logger.error(`Stream proxy: upstream returned text/html for ${channelId} — likely an error page`);
      upstream.body.on('error', () => {});
      upstream.body.dump().catch(() => {});
      res.status(502).json({ error: 'Stream unavailable — provider returned an error page instead of video' });
      return;
    }
    if (upstreamCT) res.setHeader('Content-Type', upstreamCT);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (upstreamCL) res.setHeader('Content-Length', upstreamCL);

    const contentRange = pickHeader(upstream.headers, 'content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    // Normalize Accept-Ranges to the canonical "bytes" for VOD — some upstreams
    // send malformed values (e.g. "0-1234567") that confuse strict clients.
    // Live streams keep upstream's value (or omit it).
    if (!isLive) {
      res.setHeader('Accept-Ranges', 'bytes');
    } else {
      const acceptRanges = pickHeader(upstream.headers, 'accept-ranges');
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    }

    const contentType = upstreamCT || '';
    const isM3u8 = contentType.includes('mpegurl') || contentType.includes('m3u') || streamUrl.endsWith('.m3u8');

    // Preserve 206 Partial Content when client sent a Range — required for
    // browsers/AVPlay to enable seeking. If upstream answered 200 to a Range
    // request, leave the status as-is (some servers ignore Range).
    res.status(upstream.statusCode);
    setStreamSocketOpts(res);

    const audioOnly = isLive && req.query.audio === '1';
    const pipeline = isLive
      ? selectLivePipeline({ isM3u8, audioOnly, keepSubtitles: req.query.subs === '1' })
      : isM3u8 ? 'hls-manifest' : 'binary';

    if (pipeline === 'hls-manifest') {
      // M3U8 is text — read body to string, rewrite URLs, send.
      const chunks: Buffer[] = [];
      for await (const chunk of upstream.body) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      logger.info(`Stream proxy: HLS playlist received (${body.length} bytes), rewriting URLs`);
      if (body.length > 2_000_000) {
        res.status(502).json({ error: 'HLS playlist too large to proxy safely' });
        return;
      }
      const rewritten = rewriteHlsManifest(body, upstream.finalUrl || streamUrl);
      res.send(rewritten);
    } else if (pipeline === 'ffmpeg-pipe' || pipeline === 'ffmpeg-url') {
      const releaseAudioSlot = audioOnly ? liveAudioTranscodes.acquire() : () => {};
      if (!releaseAudioSlot) {
        await upstream.body.dump().catch(() => {});
        res.removeHeader('Content-Length');
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: 'Audio-only capacity reached; retry shortly' });
        return;
      }

      // HLS manifests need a URL base for relative segments. Point ffmpeg at
      // the loopback A/V proxy (without audio=1) so its segment requests retain
      // StreamVault's validated host and CDN headers. Raw MPEG-TS stays on the
      // already-open upstream pipe.
      const ffmpegSource = pipeline === 'ffmpeg-url'
        ? `http://127.0.0.1:${PORT}/api/stream/${encodeURIComponent(channelId)}`
        : 'pipe:0';
      if (pipeline === 'ffmpeg-url') await upstream.body.dump().catch(() => {});

      logger.info(`Stream proxy: ffmpeg ${audioOnly ? 'audio-only' : '-sn'} pipe for ${channelId} (content-type: ${contentType})`);
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.removeHeader('Accept-Ranges');
      res.setHeader('Content-Type', LIVE_MPEG_TS_CONTENT_TYPE);
      res.setHeader('Cache-Control', 'no-store');
      if (audioOnly) res.setHeader('X-StreamVault-Mode', 'audio-only');

      const ff = spawn('ffmpeg', buildLiveMpegTsArgs(audioOnly, ffmpegSource), { stdio: ['pipe', 'pipe', 'pipe'] });
      let clientClosed = false;
      let processHandled = false;

      ff.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) logger.warn(`ffmpeg[${channelId}]: ${msg}`);
      });
      ff.on('error', (err) => {
        if (processHandled) return;
        processHandled = true;
        releaseAudioSlot();
        logger.error(`ffmpeg spawn failed for ${channelId}: ${err.message}`);
        upstream.body.destroy();
        if (!res.headersSent) res.status(500).json({ error: 'Stream processing failed' });
        else res.destroy(err);
      });
      ff.on('close', (code, signal) => {
        if (processHandled) return;
        processHandled = true;
        releaseAudioSlot();
        const action = liveFfmpegExitAction(code, signal, clientClosed, res.headersSent);
        const level = code === 0 || action === 'ignore' ? 'info' : 'error';
        logger[level](`ffmpeg exited ${channelId} code=${code} signal=${signal}`);
        if (action === 'end') res.end();
        else if (action === 'send-502') res.status(502).json({ error: 'Live stream processing failed' });
        else if (action === 'destroy') res.destroy(new Error('Live stream processing failed'));
      });

      // Keep the HTTP response open until the child closes so a nonzero ffmpeg
      // exit can become a 502 instead of a successful empty/truncated response.
      ff.stdout.pipe(res, { end: false });
      if (pipeline === 'ffmpeg-pipe') upstream.body.pipe(ff.stdin);
      else ff.stdin.end();

      ff.stdin.on('error', () => {});
      ff.stdout.on('error', () => {});
      upstream.body.on('error', (err) => {
        if (!clientClosed) logger.warn(`upstream error ${channelId}: ${err.message}`);
      });

      res.on('close', () => {
        if (res.writableEnded) return;
        clientClosed = true;
        logger.info(`Stream proxy: client disconnected from ${channelId}`);
        upstream.body.destroy();
        if (!ff.killed) ff.kill('SIGKILL');
      });
    } else {
      logger.info(`Stream proxy: piping binary stream for ${channelId} (content-type: ${contentType}, content-length: ${upstreamCL || 'unknown'})`);
      upstream.body.on('error', (err) => logger.warn(`upstream error ${channelId}: ${err.message}`));
      upstream.body.pipe(res);
      req.on('close', () => {
        logger.info(`Stream proxy: client disconnected from ${channelId}`);
        upstream.body.destroy();
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stream proxy error';
    logger.error(`Stream proxy failed for ${channelId}: ${msg}`);
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
  }
});

// Generic URL proxy for HLS segments and video chunks
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'url parameter required' });
    return;
  }

  const validation = validateProxySourceUrl(url);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const upstreamHeaders: Record<string, string> = { 'User-Agent': 'StreamVault/1.0' };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const upstream = await requestStream(validation.url.toString(), upstreamHeaders, 10, 30_000, allowUpstreamRedirect);

    if (upstream.statusCode >= 400) {
      upstream.body.on('error', () => {});
      upstream.body.dump().catch(() => {});
      res.status(upstream.statusCode).json({ error: `Upstream error: ${upstream.statusCode}` });
      return;
    }

    const ct = pickHeader(upstream.headers, 'content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const cl = pickHeader(upstream.headers, 'content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = pickHeader(upstream.headers, 'content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', pickHeader(upstream.headers, 'accept-ranges') || 'bytes');
    res.status(upstream.statusCode);
    setStreamSocketOpts(res);

    upstream.body.on('error', () => {});
    upstream.body.pipe(res);
    req.on('close', () => {
      upstream.body.destroy();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy error';
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
  }
});

// ---------- Recordings ----------

const mapRecordingWithProgressForApi = (recording: DBRecording) =>
  mapRecordingForApi(recording, getFinalizationProgress(recording.id, recording.status));

app.get('/api/recordings', requireAuth, (_req, res) => {
  const status = _req.query.status as string | undefined;
  const limit = parseIntegerQuery(_req.query.limit, 1, 200);
  const offset = parseIntegerQuery(_req.query.offset, 0);
  if (limit === null || offset === null) {
    res.status(400).json({ error: 'Invalid pagination parameters' });
    return;
  }
  const recordings = getRecordings({ status, limit, offset });
  res.json({ recordings: recordings.map(mapRecordingWithProgressForApi) });
});

app.post('/api/recordings', requireAuth, (req, res) => {
  const { channelId, title, startTime, endTime } = req.body;
  if (!channelId || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    res.status(400).json({ error: 'channelId, startTime, and endTime required' });
    return;
  }
  const channel = getChannelById(channelId);
  const id = randomUUID();
  const recording: DBRecording = {
    id,
    channel_id: channelId,
    channel_name: channel?.name || channelId,
    title: title || channel?.name || 'Recording',
    status: 'scheduled',
    start_time: startTime,
    end_time: endTime,
    actual_start: null,
    actual_end: null,
    file_path: null,
    file_size: 0,
    duration: 0,
    error: null,
    rule_id: null,
    program_title: title || null,
    created_at: Date.now(),
  };
  insertRecording(recording);

  // If start time is in the past or now, start immediately
  if (startTime <= Date.now()) {
    startRecording(id).catch(err => {
      logger.error(`Failed to start immediate recording: ${err}`);
    });
  }

  res.json({ recording: mapRecordingWithProgressForApi(getRecording(id) ?? recording) });
});

app.post('/api/recordings/from-program', requireAuth, (req, res) => {
  let lookup: ReturnType<typeof validateFromProgramLookup>;
  try {
    lookup = validateFromProgramLookup(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const program = lookup.kind === 'airingKey'
    ? getProgramByAiringKey(lookup.airingKey)
    : getProgramByLegacyIdentity(lookup.channelId, lookup.programStart, lookup.programStop);
  if (!program) {
    res.status(404).json({ error: 'Program airing not found' });
    return;
  }
  const airingKey = deriveProgramAiringKey(program);
  const channel = getChannelById(program.channel_id);
  const id = randomUUID();
  const recording: DBRecording = {
    id,
    channel_id: program.channel_id,
    channel_name: channel?.name || program.channel_id,
    title: program.title || 'Recording',
    status: 'scheduled',
    start_time: program.start_time,
    end_time: program.stop_time,
    actual_start: null,
    actual_end: null,
    file_path: null,
    file_size: 0,
    duration: 0,
    error: null,
    rule_id: null,
    program_title: program.title || null,
    airing_key: airingKey,
    content_key: program.content_key ?? null,
    created_at: Date.now(),
  };
  const inserted = insertRecordingForAiring(recording);

  if (inserted.id === id && program.start_time <= Date.now()) {
    startRecording(id).catch(err => {
      logger.error(`Failed to start immediate recording: ${err}`);
    });
  }

  res.json({ recording: mapRecordingWithProgressForApi(getRecording(inserted.id) ?? inserted) });
});

app.get('/api/recordings/:id', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  res.json({ recording: mapRecordingWithProgressForApi(recording) });
});

app.get('/api/recordings/:id/commercial-segments', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  const segments = getCommercialSegments(recordingId);
  const globalAutoSkip = parseBooleanConfig(getConfig('commercial_auto_skip', 'false'), false);
  res.json(mapCommercialSegmentsResponse(recording, segments, globalAutoSkip));
});

app.post('/api/recordings/:id/analyze', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.status !== 'completed' || !getRecordingMasterFilePath(recordingId)) {
    res.status(409).json({ error: 'Commercial analysis requires a completed master recording' });
    return;
  }
  if (recording.analysis_state === 'queued' || recording.analysis_state === 'analyzing') {
    res.status(409).json({ error: 'Commercial analysis is already queued or running' });
    return;
  }
  if (!isCommercialAnalysisAvailable()) {
    res.status(503).json({ error: 'Comskip unavailable; commercial analysis is not installed' });
    return;
  }
  if (!queueCommercialAnalysis(recordingId, Date.now())) {
    res.status(409).json({ error: 'Commercial analysis is already queued or running' });
    return;
  }
  notifyCommercialAnalysisQueued();
  res.status(202).json({ status: 'queued' });
});

app.put('/api/recordings/:id/commercial-segments', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.analysis_state === 'queued' || recording.analysis_state === 'analyzing') {
    res.status(409).json({ error: 'Commercial segments cannot be edited while analysis is queued or running' });
    return;
  }
  let segments;
  try {
    segments = validateCommercialSegmentReplacement(req.body?.segments, recording.duration);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const nextState = segments.some(segment => segment.reviewState === 'suggested') ? 'review_needed' : 'ready';
  if (!replaceCommercialSegmentsIfIdle(recordingId, segments, nextState, Date.now())) {
    res.status(409).json({ error: 'Commercial segments cannot be edited while analysis is queued or running' });
    return;
  }
  const updated = getRecording(recordingId)!;
  const globalAutoSkip = parseBooleanConfig(getConfig('commercial_auto_skip', 'false'), false);
  res.json(mapCommercialSegmentsResponse(updated, getCommercialSegments(recordingId), globalAutoSkip));
});

app.patch('/api/recordings/:id/commercial-skip', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  let enabled: boolean | null;
  try {
    enabled = validateCommercialSkipOverride(req.body?.enabled);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  updateRecording(recordingId, { commercial_skip_override: enabled === null ? null : enabled ? 1 : 0 });
  const updated = getRecording(recordingId)!;
  const globalAutoSkip = parseBooleanConfig(getConfig('commercial_auto_skip', 'false'), false);
  res.json(mapCommercialSegmentsResponse(updated, getCommercialSegments(recordingId), globalAutoSkip));
});

app.delete('/api/recordings/:id', requireAuth, async (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  await deleteRecordingFile(recordingId);
  if (recording.status !== 'completed') {
    markRecordingRuleCadenceRetry(
      recording.rule_id,
      recording.rule_revision ?? null,
      recording.program_start_time ?? recording.start_time,
      recording.airing_key ?? null,
    );
  }
  deleteRecording(recordingId);
  if (recording.rule_id) reconcileRecordingRule(recording.rule_id);
  res.json({ ok: true });
});

app.post('/api/recordings/:id/cancel', requireAuth, async (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (['scheduled', 'recording', 'finalizing'].includes(recording.status)) {
    await cancelRecording(recordingId, true);
  }
  res.json({ ok: true });
});

app.post('/api/recordings/:id/stop', requireAuth, async (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.status === 'recording' || recording.status === 'finalizing') {
    await stopRecording(recordingId);
  }
  res.json({ ok: true });
});

app.post('/api/recordings/:id/playback-ticket', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  if (!getRecordingFilePath(recordingId)) {
    res.status(404).json({ error: 'Recording file not found' });
    return;
  }
  const authToken = process.env.STREAMVAULT_AUTH_TOKEN;
  const directUrl = `/api/recordings/${encodeURIComponent(recordingId)}/stream`;
  if (!authToken) {
    res.json({ url: directUrl, expiresAt: Date.now() + 60_000 });
    return;
  }
  const { ticket, expiresAt } = createRecordingPlaybackTicket(recordingId, authToken);
  res.json({ url: `${directUrl}?ticket=${encodeURIComponent(ticket)}`, expiresAt });
});

app.get('/api/recordings/:id/stream', (req, res) => {
  const recordingId = String(req.params.id);
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
  if (!canAccessRecordingStream(recordingId, process.env.STREAMVAULT_AUTH_TOKEN, ticket)) {
    res.status(401).json({ error: 'Valid playback ticket required' });
    return;
  }
  const filePath = getRecordingFilePath(recordingId);
  if (!filePath) {
    res.status(404).json({ error: 'Recording file not found' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).json({ error: 'Recording file not found' });
    return;
  }
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = filePath.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';

  if (range) {
    const parsed = parseByteRange(range, fileSize);
    if (!parsed.ok) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': parsed.chunkSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start: parsed.start, end: parsed.end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/api/recording-status', requireAuth, (_req, res) => {
  res.json(getSchedulerStatus());
});

// ---------- Recording Rules ----------

app.get('/api/recording-rules', requireAuth, (_req, res) => {
  const rules = getRecordingRules();
  res.json({ rules });
});

app.post('/api/recording-rules', requireAuth, (req, res) => {
  let payload: ReturnType<typeof validateRecordingRulePayload>;
  try {
    payload = validateRecordingRulePayload(req.body, false);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const id = randomUUID();
  insertRecordingRule({
    id,
    channel_id: payload.channel_id!,
    channel_name: payload.channel_name!,
    match_title: payload.match_title!,
    match_type: payload.match_type!,
    enabled: payload.enabled ?? 1,
    padding_before: payload.padding_before!,
    padding_after: payload.padding_after!,
    max_recordings: payload.max_recordings!,
    retention_count: payload.retention_count!,
    airing_policy: payload.airing_policy!,
    repeat_policy: payload.repeat_policy as DBRecordingRule['repeat_policy'],
    cadence_mode: payload.cadence_mode!,
    cadence_interval: payload.cadence_interval!,
    daily_start_minutes: payload.daily_start_minutes!,
    schedule_timezone: payload.schedule_timezone!,
    rule_revision: 1,
    cadence_last_success_start: null,
    cadence_last_success_key: null,
    cadence_occurrence_progress: 0,
    cadence_cursor_start: null,
    cadence_cursor_key: null,
    cadence_retry_start: null,
    cadence_retry_key: null,
    created_at: Date.now(),
  });
  // Immediately check this rule for matches.
  reconcileRecordingRule(id);
  res.json({ rule: getRecordingRule(id) });
});

app.put('/api/recording-rules/:id', requireAuth, async (req, res) => {
  const ruleId = String(req.params.id);
  const rule = getRecordingRule(ruleId);
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  let updates: ReturnType<typeof validateRecordingRulePayload>;
  try {
    updates = validateRecordingRulePayload(req.body, true);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  let missingDuringUpdate = false;
  let updateError: string | null = null;
  await withRuleRetentionLock(ruleId, async () => {
    const current = getRecordingRule(ruleId);
    if (!current) {
      missingDuringUpdate = true;
      return;
    }
    try {
      let currentForVersion = current;
      if (current.airing_policy === 'every' && updates.airing_policy === 'once' &&
          current.cadence_last_success_start === null) {
        const latestAccepted = getRecordingsByRuleId(ruleId)
          .filter(recording => recording.status === 'completed' &&
            recording.channel_id === current.channel_id &&
            (recording.rule_revision ?? 1) === current.rule_revision &&
            matchProgramTitle(
              recording.program_title ?? recording.title,
              current.match_title,
              current.match_type,
            ))
          .sort((left, right) => {
            const leftStart = left.program_start_time ?? left.start_time + current.padding_before;
            const rightStart = right.program_start_time ?? right.start_time + current.padding_before;
            return rightStart - leftStart || (right.airing_key ?? '').localeCompare(left.airing_key ?? '');
          })[0];
        if (latestAccepted) {
          currentForVersion = {
            ...current,
            cadence_last_success_start: latestAccepted.program_start_time ??
              latestAccepted.start_time + current.padding_before,
            cadence_last_success_key: latestAccepted.airing_key ?? null,
          };
        }
      }
      const persistedUpdates = versionRecordingRuleUpdates(
        currentForVersion,
        updates as Partial<Omit<DBRecordingRule, 'id'>>,
      );
      updateRecordingRule(ruleId, persistedUpdates);
      if (updates.airing_policy === 'once') await reconcileRecordOnceRule(ruleId);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }
  });
  if (missingDuringUpdate) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  if (updateError) {
    res.status(400).json({ error: updateError });
    return;
  }
  if (updates.retention_count !== undefined) await enforceRuleRetention(ruleId);
  reconcileRecordingRule(ruleId);
  const updatedRule = getRecordingRule(ruleId);
  if (!updatedRule) {
    res.status(409).json({ error: 'Rule was deleted during update' });
    return;
  }
  res.json({ rule: updatedRule });
});

app.delete('/api/recording-rules/:id', requireAuth, async (req, res) => {
  const ruleId = String(req.params.id);
  await withRuleRetentionLock(ruleId, () => { deleteRecordingRule(ruleId); });
  reconcileRecordingRule(ruleId);
  res.json({ ok: true });
});

// ---------- Config ----------

app.get('/api/config', requireAuth, (_req, res) => {
  res.json(maskConfigResponse({
    inputMode: getConfig('input_mode', 'xtream'),
    playlistUrl: getConfig('playlist_url'),
    epgUrl: getConfig('epg_url'),
    xtreamServer: getConfig('xtream_server'),
    xtreamUsername: getConfig('xtream_username'),
    xtreamPassword: getConfig('xtream_password'),
    syncInterval: getConfig('sync_interval', '24h'),
    commercialAutoSkip: parseBooleanConfig(getConfig('commercial_auto_skip', 'false'), false),
  }));
});

app.put('/api/config', requireAuth, (req, res) => {
  const { inputMode, playlistUrl, epgUrl, xtreamServer, xtreamUsername, xtreamPassword, syncInterval, commercialAutoSkip } = req.body;
  if (commercialAutoSkip !== undefined && typeof commercialAutoSkip !== 'boolean') {
    res.status(400).json({ error: 'commercialAutoSkip must be a boolean' });
    return;
  }
  if (inputMode !== undefined && !['xtream', 'manual'].includes(inputMode)) {
    res.status(400).json({ error: 'Invalid inputMode' });
    return;
  }
  if (syncInterval !== undefined && !['startup', '6h', '12h', '24h', 'manual'].includes(syncInterval)) {
    res.status(400).json({ error: 'Invalid syncInterval' });
    return;
  }
  for (const [name, value] of [['playlistUrl', playlistUrl], ['epgUrl', epgUrl], ['xtreamServer', xtreamServer]] as const) {
    if (value !== undefined && value !== '') {
      const validation = name === 'xtreamServer' ? validateXtreamServerUrl(value) : validateExternalHttpUrl(value);
      if (!validation.ok) {
        res.status(400).json({ error: `${name}: ${validation.error}` });
        return;
      }
    }
  }
  if (inputMode !== undefined) setConfig('input_mode', inputMode);
  if (playlistUrl !== undefined) setConfig('playlist_url', playlistUrl);
  if (epgUrl !== undefined) setConfig('epg_url', epgUrl);
  if (xtreamServer !== undefined) setConfig('xtream_server', xtreamServer);
  if (xtreamUsername !== undefined) setConfig('xtream_username', xtreamUsername);
  if (xtreamPassword !== undefined && xtreamPassword !== '') setConfig('xtream_password', xtreamPassword);
  if (syncInterval !== undefined) setConfig('sync_interval', syncInterval);
  if (commercialAutoSkip !== undefined) setConfig('commercial_auto_skip', commercialAutoSkip ? 'true' : 'false');
  res.json({ ok: true });
});

// ---------- Sync ----------

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

app.post('/api/sync', requireAuth, (_req, res) => {
  sync();
  res.json({ ok: true, message: 'Sync started' });
});

app.post('/api/sync/cancel', requireAuth, (_req, res) => {
  cancelSync();
  res.json({ ok: true, message: 'Sync cancelled' });
});

app.post('/api/crawl', requireAuth, (_req, res) => {
  startCrawl();
  res.json({ ok: true, message: 'Crawl started' });
});

app.post('/api/crawl/cancel', requireAuth, (_req, res) => {
  cancelCrawl();
  res.json({ ok: true, message: 'Crawl cancelled' });
});

// ---------- API error handler ----------

app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API error: ${err.message}`);
  if (isDatabaseCorruptionError(err)) {
    res.status(503).json({ error: 'Database recovery in progress; retry shortly' });
    // A clean process restart re-enters the startup recovery path, quarantines
    // the damaged database, and restores the newest validated backup.
    setImmediate(() => shutdown('database corruption detected'));
    return;
  }
  res.status(500).json({ error: err.message });
});

// ---------- Serve frontend (PWA) ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'public');

// Serve static files — fingerprinted assets cached forever, everything else no-cache
app.use(express.static(FRONTEND_DIR, {
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.includes('/assets/')) {
      // Vite-fingerprinted files (hash in filename) — safe to cache forever
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // index.html, manifest, icons — always revalidate
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// SPA fallback: serve index.html for navigation requests only.
// Requests for missing assets (old JS/CSS chunks after deploy) get a 404
// instead of index.html, which would cause "text/html is not a valid JS MIME type" errors.
app.get('/{*path}', (req, res) => {
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---------- Start ----------

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let backupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextBackup(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  backupTimer = setTimeout(() => {
    scheduleNextBackup();
    void backupDatabaseIfDue(BACKUP_INTERVAL_MS);
  }, next.getTime() - now.getTime());
  backupTimer.unref();
  logger.info(`Next database backup scheduled for ${next.toLocaleString()}`);
}

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
  // Prewarm DNS+TLS to the Xtream upstream so first user click hits a warm socket
  const xtreamServer = getConfig('xtream_server');
  if (xtreamServer) prewarmUpstream(xtreamServer);
  // Start recording scheduler, recover interrupted recordings, and resume analysis.
  startCommercialAnalysisWorker();
  recoverRecordings().then(() => {
    startScheduler();
  }).catch(err => {
    logger.error(`Failed to recover recordings: ${err}`);
    startScheduler();
  });
  scheduleNextBackup();
});

// ---------- Graceful shutdown ----------

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  if (backupTimer) clearTimeout(backupTimer);
  const schedulerShutdown = stopScheduler().catch(error => {
    logger.warn(`Scheduler shutdown failed: ${error instanceof Error ? error.message : error}`);
  });

  const forceExit = setTimeout(() => {
    logger.error('Shutdown grace period exceeded, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  const backupShutdown = stopDatabaseBackupWorker().catch(error => {
    logger.warn(`Backup worker shutdown failed: ${error instanceof Error ? error.message : error}`);
  });
  const httpShutdown = new Promise<void>(resolve => {
    httpServer.close(err => {
      if (err) logger.error(`HTTP server close error: ${err.message}`);
      else logger.info('HTTP server closed');
      resolve();
    });
  });

  const recorderAndAnalysisShutdown = (async () => {
    await Promise.all([schedulerShutdown, stopAllRecordings()]);
    await stopCommercialAnalysisWorker();
  })().catch(error => {
    logger.warn(`Recorder/analysis shutdown failed: ${error instanceof Error ? error.message : error}`);
  });

  void Promise.all([backupShutdown, httpShutdown, recorderAndAnalysisShutdown]).then(() => {
    closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

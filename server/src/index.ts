import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
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
  getConfig, setConfig,
  getCategories, getCategoryByName, getContentTypeCounts,
  saveChannelsForCategory, markCategoryFetched,
  searchChannelsByName, getChannelCountByContentType,
  getChannelsByContentTypeCursor, getChannelsByGroupCursor,
  insertRecording, updateRecording, deleteRecording, getRecording, getRecordings,
  insertRecordingRule, updateRecordingRule, deleteRecordingRule, getRecordingRules, getRecordingRule,
  closeDatabase, backupDatabase, getDatabaseHealth,
} from './db.js';
import type { DBRecording } from './db.js';
import { getStatus, sync, cancelSync, startupSync, startCrawl, cancelCrawl } from './sync.js';
import { fetchXtreamStreamsByCategory, fetchXtreamShortEpg, fetchAllCategoryStreams, fetchXtreamSeriesInfo, fetchXtreamVodInfo } from './xtream.js';
import type { XtreamConfig } from './xtream.js';
import { logger } from './logger.js';
import { requestStream, pickHeader, VLC_HEADERS } from './stream-utils.js';
import { prewarmUpstream } from './http-agent.js';
import { startRecording, stopRecording, cancelRecording, deleteRecordingFile, getRecordingFilePath } from './recorder.js';
import { startScheduler, getSchedulerStatus, matchRules } from './recording-scheduler.js';
import { recoverRecordings } from './recorder.js';
import { rewriteHlsManifest } from './hls.js';
import { buildFragmentedMp4Args } from './vod-remux.js';
import { parseByteRange } from './ranges.js';
import { allowedProxyHostsFromConfig, maskConfigResponse, normalizeAllowedOrigins, requireAuth, validateExternalHttpUrl } from './security.js';
import { isDatabaseCorruptionError } from './db-lifecycle.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

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

  // If a specific group hasn't been crawled yet, trigger a background fetch (never block)
  if (group && group !== 'All' && inputMode === 'xtream') {
    const category = getCategoryByName(group);
    if (category && !category.fetched_at) {
      const config = getXtreamConfig();
      if (config) {
        logger.info(`Background fetch for uncrawled category "${group}" (${category.id})`);
        fetchXtreamStreamsByCategory(config, category.id, category.name).then(channels => {
          saveChannelsForCategory(category.id, channels);
          markCategoryFetched(category.id, channels.length);
          logger.info(`Background fetch done for "${group}": ${channels.length} streams`);
        }).catch(err => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          logger.error(`Background fetch failed for "${group}": ${msg}`);
        });
      }
    }
  }

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
    // Fetch by group — trigger background fetch if needed
    if (inputMode === 'xtream') {
      const category = getCategoryByName(group);
      if (category && !category.fetched_at) {
        const config = getXtreamConfig();
        if (config) {
          logger.info(`Background fetch for uncrawled category "${group}" (${category.id})`);
          fetchXtreamStreamsByCategory(config, category.id, category.name).then(channels => {
            saveChannelsForCategory(category.id, channels);
            markCategoryFetched(category.id, channels.length);
          }).catch(err => {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            logger.error(`Background fetch failed for "${group}": ${msg}`);
          });
        }
      }
    }
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

app.get('/api/epg/batch', (req, res) => {
  const idsParam = req.query.ids as string | undefined;
  if (!idsParam) {
    res.json({ programs: {} });
    return;
  }
  const channelIds = idsParam.split(',').slice(0, 100); // cap at 100
  const now = Date.now();
  const from = now - 2 * 60 * 60 * 1000; // 2h ago
  const to = now + 6 * 60 * 60 * 1000;   // 6h ahead
  const dbPrograms = getProgramsByChannelIds(channelIds, from, to);

  // Group by channel ID
  const grouped: Record<string, Array<{ title: string; description: string; start: string; stop: string }>> = {};
  for (const p of dbPrograms) {
    if (!grouped[p.channel_id]) grouped[p.channel_id] = [];
    grouped[p.channel_id].push({
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
  const dbPrograms = getProgramsByChannel(channelId, from, to);
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

// ---------- Browser-compatible VOD remux ----------
// iOS Safari does not play provider MKV files directly. Remuxing the existing
// HEVC/AAC streams into fragmented MP4 preserves quality and avoids the CPU
// cost and latency of a transcode.
app.get('/api/remux/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const channel = getChannelById(channelId);
  if (!channel?.url || channel.content_type === 'livetv') {
    res.status(404).json({ error: 'VOD stream not found' });
    return;
  }

  // Use the existing loopback stream proxy so the provider request retains
  // StreamVault's CDN-compatible headers and credential handling.
  const sourceUrl = `http://127.0.0.1:${PORT}/api/stream/${encodeURIComponent(channelId)}`;
  const ff = spawn('ffmpeg', buildFragmentedMp4Args(sourceUrl), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  setStreamSocketOpts(res);

  ff.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) logger.warn(`VOD remux[${channelId}]: ${message}`);
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
    const validation = validateExternalHttpUrl(req.query.url as string, allowedProxyHostsFromConfig(getConfig('xtream_server'), process.env.STREAMVAULT_PROXY_ALLOWED_HOSTS));
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
  logger.info(`Stream proxy: ${channelId} "${channelName}" type=${contentType} → ${streamUrl.substring(0, 80)}...`);

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
    );

    logger.info(`Stream proxy: final URL=${upstream.finalUrl.substring(0, 100)}...`);
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
      logger.error(`Stream proxy: upstream returned text/html for ${channelId} — likely an error page (final URL: ${upstream.finalUrl.substring(0, 100)})`);
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

    if (isM3u8) {
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
    } else if (isLive && req.query.subs !== '1') {
      // Live MPEG-TS: pipe through ffmpeg to drop subtitle PIDs (`-sn`) and
      // CEA-608/708 SEI NAL units (filter_units bitstream filter). AVPlay
      // on Tizen renders DVB/teletext subs and embedded captions natively
      // without exposing controls to the web app. Stripping the packets
      // and SEI here is the only reliable way to suppress them. `-c copy`
      // = no transcoding, only demuxer/muxer overhead. Skip when the
      // client opts in to keeping subs via `?subs=1`.
      logger.info(`Stream proxy: ffmpeg -sn pipe for ${channelId} (content-type: ${contentType})`);
      // ffmpeg's output length is unknown; never forward upstream Content-Length.
      res.removeHeader('Content-Length');

      // CEA-608/708 closed captions ride inside H.264 SEI NAL units (type 6)
      // and HEVC SEI (types 39/40), so `-sn` alone won't drop them — that
      // flag only filters separate subtitle PIDs. `filter_units` is a
      // bitstream filter that strips matching NAL types from a copied
      // stream without re-encoding. List both H.264 and HEVC SEI types so
      // the same command works regardless of codec; non-matching types are
      // silently ignored.
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+nobuffer+discardcorrupt',
        '-i', 'pipe:0',
        '-map', '0:v', '-map', '0:a?',
        '-c', 'copy', '-sn',
        '-bsf:v', 'filter_units=remove_types=6|39|40',
        '-f', 'mpegts', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      ff.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) logger.warn(`ffmpeg[${channelId}]: ${msg}`);
      });
      ff.on('error', (err) => {
        logger.error(`ffmpeg spawn failed for ${channelId}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Stream processing failed' });
        upstream.body.destroy();
      });
      ff.on('exit', (code, signal) => {
        logger.info(`ffmpeg exited ${channelId} code=${code} signal=${signal}`);
      });

      // Upstream → ffmpeg stdin → response. Default pipe end:true closes ff.stdin
      // on upstream EOF, which is what we want for live drops.
      upstream.body.pipe(ff.stdin);
      ff.stdout.pipe(res);

      // Suppress EPIPE noise when the other side of these pipes closes first
      ff.stdin.on('error', () => {});
      ff.stdout.on('error', () => {});
      upstream.body.on('error', (err) => logger.warn(`upstream error ${channelId}: ${err.message}`));

      req.on('close', () => {
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

  const validation = validateExternalHttpUrl(url, allowedProxyHostsFromConfig(getConfig('xtream_server'), process.env.STREAMVAULT_PROXY_ALLOWED_HOSTS));
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const upstreamHeaders: Record<string, string> = { 'User-Agent': 'StreamVault/1.0' };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const upstream = await requestStream(validation.url.toString(), upstreamHeaders, 10, 30_000);

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

app.get('/api/recordings', requireAuth, (_req, res) => {
  const status = _req.query.status as string | undefined;
  const limit = parseIntegerQuery(_req.query.limit, 1, 200);
  const offset = parseIntegerQuery(_req.query.offset, 0);
  if (limit === null || offset === null) {
    res.status(400).json({ error: 'Invalid pagination parameters' });
    return;
  }
  const recordings = getRecordings({ status, limit, offset });
  res.json({ recordings });
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

  res.json({ recording });
});

app.post('/api/recordings/from-program', requireAuth, (req, res) => {
  const { channelId, programStart, programStop, title } = req.body;
  if (!channelId || !Number.isFinite(programStart) || !Number.isFinite(programStop) || programStop <= programStart) {
    res.status(400).json({ error: 'channelId, programStart, and programStop required' });
    return;
  }
  const channel = getChannelById(channelId);
  const id = randomUUID();
  const recording: DBRecording = {
    id,
    channel_id: channelId,
    channel_name: channel?.name || channelId,
    title: title || 'Recording',
    status: 'scheduled',
    start_time: programStart,
    end_time: programStop,
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

  if (programStart <= Date.now()) {
    startRecording(id).catch(err => {
      logger.error(`Failed to start immediate recording: ${err}`);
    });
  }

  res.json({ recording });
});

app.get('/api/recordings/:id', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  res.json({ recording });
});

app.delete('/api/recordings/:id', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.status === 'recording') {
    cancelRecording(recordingId, true).catch(() => {});
  } else {
    deleteRecordingFile(recordingId);
  }
  deleteRecording(recordingId);
  res.json({ ok: true });
});

app.post('/api/recordings/:id/cancel', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.status === 'recording') {
    cancelRecording(recordingId).catch(() => {});
  } else if (recording.status === 'scheduled') {
    updateRecording(recordingId, { status: 'cancelled' });
  }
  res.json({ ok: true });
});

app.post('/api/recordings/:id/stop', requireAuth, (req, res) => {
  const recordingId = String(req.params.id);
  const recording = getRecording(recordingId);
  if (!recording) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  if (recording.status === 'recording') {
    stopRecording(recordingId).catch(() => {});
  }
  res.json({ ok: true });
});

app.get('/api/recordings/:id/stream', (req, res) => {
  const filePath = getRecordingFilePath(String(req.params.id));
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
  const { channelId, channelName, matchTitle, matchType, paddingBefore, paddingAfter, maxRecordings } = req.body;
  if (!channelId || !matchTitle) {
    res.status(400).json({ error: 'channelId and matchTitle required' });
    return;
  }
  if (matchType !== undefined && !['contains', 'exact', 'startsWith'].includes(matchType)) {
    res.status(400).json({ error: 'Invalid matchType' });
    return;
  }
  const id = randomUUID();
  insertRecordingRule({
    id,
    channel_id: channelId,
    channel_name: channelName || channelId,
    match_title: matchTitle,
    match_type: matchType || 'contains',
    enabled: 1,
    padding_before: paddingBefore ?? 120_000,
    padding_after: paddingAfter ?? 300_000,
    max_recordings: maxRecordings ?? 0,
    created_at: Date.now(),
  });
  // Immediately check for matches
  matchRules();
  res.json({ rule: getRecordingRule(id) });
});

app.put('/api/recording-rules/:id', requireAuth, (req, res) => {
  const ruleId = String(req.params.id);
  const rule = getRecordingRule(ruleId);
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (req.body.matchTitle !== undefined) updates.match_title = req.body.matchTitle;
  if (req.body.matchType !== undefined) {
    if (!['contains', 'exact', 'startsWith'].includes(req.body.matchType)) {
      res.status(400).json({ error: 'Invalid matchType' });
      return;
    }
    updates.match_type = req.body.matchType;
  }
  if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;
  if (req.body.paddingBefore !== undefined) updates.padding_before = req.body.paddingBefore;
  if (req.body.paddingAfter !== undefined) updates.padding_after = req.body.paddingAfter;
  if (req.body.maxRecordings !== undefined) updates.max_recordings = req.body.maxRecordings;
  updateRecordingRule(ruleId, updates);
  res.json({ rule: getRecordingRule(ruleId) });
});

app.delete('/api/recording-rules/:id', requireAuth, (req, res) => {
  deleteRecordingRule(String(req.params.id));
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
  }));
});

app.put('/api/config', requireAuth, (req, res) => {
  const { inputMode, playlistUrl, epgUrl, xtreamServer, xtreamUsername, xtreamPassword, syncInterval } = req.body;
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
      const validation = validateExternalHttpUrl(value);
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

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
  // Prewarm DNS+TLS to the Xtream upstream so first user click hits a warm socket
  const xtreamServer = getConfig('xtream_server');
  if (xtreamServer) prewarmUpstream(xtreamServer);
  // Start recording scheduler and recover any interrupted recordings
  recoverRecordings().then(() => {
    startScheduler();
  }).catch(err => {
    logger.error(`Failed to recover recordings: ${err}`);
    startScheduler();
  });
  // Initial backup on boot, then daily.
  backupDatabase();
});

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const backupTimer = setInterval(() => { backupDatabase(); }, BACKUP_INTERVAL_MS);
if (typeof backupTimer.unref === 'function') backupTimer.unref();

// ---------- Graceful shutdown ----------

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  clearInterval(backupTimer);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown grace period exceeded, forcing exit');
    process.exit(1);
  }, 8000);
  forceExit.unref();

  httpServer.close(err => {
    if (err) logger.error(`HTTP server close error: ${err.message}`);
    else logger.info('HTTP server closed');
    closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

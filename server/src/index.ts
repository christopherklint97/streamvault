import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import {
  getChannels, getChannelById, getChannelsByGroup, getChannelCountByGroup, getGroups, getRegions,
  getPrograms, getConfig, setConfig,
  getCategories, getCategoryByName, getContentTypeCounts,
  saveChannelsForCategory, markCategoryFetched,
  searchChannelsByName, getChannelCountByContentType,
  getChannelsByContentTypeCursor, getChannelsByGroupCursor,
} from './db.js';
import { getStatus, sync, cancelSync, startupSync, startCrawl, cancelCrawl } from './sync.js';
import { fetchXtreamStreamsByCategory, fetchXtreamShortEpg, fetchAllCategoryStreams, fetchXtreamSeriesInfo } from './xtream.js';
import type { XtreamConfig } from './xtream.js';
import { logger } from './logger.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
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
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const cursorSort = req.query.cursorSort ? parseInt(req.query.cursorSort as string, 10) : undefined;
  const cursorName = req.query.cursorName as string | undefined;
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
    dbChannels = getChannels();
    total = dbChannels.length;
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

// ---------- Browse (lightweight, paginated by content type) ----------

app.get('/api/browse', async (req, res) => {
  const contentType = req.query.type as string | undefined;
  const group = req.query.group as string | undefined;
  const limit = parseInt(req.query.limit as string || '20', 10);
  const after = req.query.after as string | undefined; // cursor: name of last item
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
    dbChannels = getChannelsByGroupCursor(group, limit, after);
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

  // Cursor is the name of the last item — next page starts after this
  const lastItem = dbChannels[dbChannels.length - 1];
  const nextCursor = lastItem && dbChannels.length === limit ? lastItem.name : null;

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
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
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
    const programs = await fetchXtreamShortEpg(config, [streamId]);
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

// ---------- Stream Proxy ----------
// Proxies stream URLs through the server so mobile clients don't need
// direct access to the Xtream server (avoids CORS and network issues).

/** Manually follow redirects while preserving headers (Node fetch strips them across origins) */
async function fetchWithRedirects(url: string, headers: Record<string, string>, maxRedirects = 10, timeout?: number): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const opts: RequestInit = {
      headers,
      redirect: 'manual',
    };
    if (timeout) opts.signal = AbortSignal.timeout(timeout);
    const resp = await fetch(currentUrl, opts);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error(`Redirect ${resp.status} with no Location header`);
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).href;
      logger.info(`Stream proxy: redirect ${resp.status} → ${currentUrl.substring(0, 100)}...`);
      // Detect Cloudflare abuse redirect
      if (currentUrl.includes('cloudflare-terms-of-service-abuse') || currentUrl.includes('cloudflare.com/abuse')) {
        throw new Error('Stream blocked by Cloudflare — provider CDN flagged for abuse');
      }
      // Consume body to free resources
      await resp.text().catch(() => {});
      continue;
    }
    return resp;
  }
  throw new Error('Too many redirects');
}

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
    streamUrl = req.query.url as string;
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
    // Full VLC-like headers to get past Cloudflare
    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
    };
    // Forward Range header for VOD (seeking), skip for live streams
    if (req.headers.range && !isLive) {
      upstreamHeaders['Range'] = req.headers.range;
      logger.info(`Stream proxy: forwarding Range header: ${req.headers.range}`);
    }

    // Manually follow redirects to keep VLC headers on every hop
    const upstream = await fetchWithRedirects(
      streamUrl,
      upstreamHeaders,
      10,
      isLive ? undefined : 30_000,
    );

    logger.info(`Stream proxy: final URL=${upstream.url.substring(0, 100)}...`);
    logger.info(`Stream proxy: upstream responded ${upstream.status} ${upstream.statusText}, content-type=${upstream.headers.get('content-type')}, content-length=${upstream.headers.get('content-length')}`);

    // Detect Cloudflare abuse page (tiny response masquerading as video)
    const contentLength = upstream.headers.get('content-length');
    const cl = contentLength ? parseInt(contentLength, 10) : null;
    if (cl && cl < 100_000 && !isLive) {
      const finalHost = new URL(upstream.url).hostname;
      if (finalHost.includes('cloudflare') || finalHost.includes('abuse')) {
        logger.error(`Stream proxy: Cloudflare blocked stream for ${channelId} (redirected to ${finalHost}, ${cl} bytes)`);
        res.status(502).json({ error: 'Stream blocked by CDN protection. The content provider may be restricting access.' });
        return;
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      logger.error(`Stream proxy: upstream error ${upstream.status} for ${channelId}`);
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
      return;
    }

    // Reject HTML responses — upstream returned an error page instead of video
    const ct = upstream.headers.get('content-type');
    if (ct && ct.includes('text/html')) {
      logger.error(`Stream proxy: upstream returned text/html for ${channelId} — likely an error page (final URL: ${upstream.url.substring(0, 100)})`);
      res.status(502).json({ error: 'Stream unavailable — provider returned an error page instead of video' });
      return;
    }
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    } else if (!isLive) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    const contentType = ct || '';
    const isM3u8 = contentType.includes('mpegurl') || contentType.includes('m3u') || streamUrl.endsWith('.m3u8');

    res.status(upstream.status);

    if (isM3u8) {
      const body = await upstream.text();
      logger.info(`Stream proxy: HLS playlist received (${body.length} bytes), rewriting URLs`);
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const rewritten = body.replace(/^(?!#)(\S+)/gm, (line: string) => {
        if (line.startsWith('http://') || line.startsWith('https://')) {
          return `/api/proxy?url=${encodeURIComponent(line)}`;
        }
        return `/api/proxy?url=${encodeURIComponent(baseUrl + line)}`;
      });
      res.send(rewritten);
    } else {
      logger.info(`Stream proxy: piping binary stream for ${channelId} (content-type: ${contentType}, content-length: ${contentLength || 'unknown'})`);
      if (!upstream.body) {
        logger.error(`Stream proxy: no response body for ${channelId}`);
        res.status(502).json({ error: 'No response body' });
        return;
      }
      const nodeStream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
      nodeStream.pipe(res);
      req.on('close', () => {
        logger.info(`Stream proxy: client disconnected from ${channelId}`);
        nodeStream.destroy();
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

  try {
    const upstreamHeaders: Record<string, string> = { 'User-Agent': 'StreamVault/1.0' };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: upstreamHeaders,
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
      return;
    }

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    res.status(upstream.status);

    if (!upstream.body) {
      res.status(502).json({ error: 'No response body' });
      return;
    }
    // @ts-expect-error Node fetch body is a ReadableStream
    upstream.body.pipe(res);
    req.on('close', () => {
      upstream.body?.cancel?.();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy error';
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
  }
});

// ---------- Config ----------

app.get('/api/config', (_req, res) => {
  res.json({
    inputMode: getConfig('input_mode', 'xtream'),
    playlistUrl: getConfig('playlist_url'),
    epgUrl: getConfig('epg_url'),
    xtreamServer: getConfig('xtream_server'),
    xtreamUsername: getConfig('xtream_username'),
    xtreamPassword: getConfig('xtream_password'),
    syncInterval: getConfig('sync_interval', '24h'),
  });
});

app.put('/api/config', (req, res) => {
  const { inputMode, playlistUrl, epgUrl, xtreamServer, xtreamUsername, xtreamPassword, syncInterval } = req.body;
  if (inputMode !== undefined) setConfig('input_mode', inputMode);
  if (playlistUrl !== undefined) setConfig('playlist_url', playlistUrl);
  if (epgUrl !== undefined) setConfig('epg_url', epgUrl);
  if (xtreamServer !== undefined) setConfig('xtream_server', xtreamServer);
  if (xtreamUsername !== undefined) setConfig('xtream_username', xtreamUsername);
  if (xtreamPassword !== undefined) setConfig('xtream_password', xtreamPassword);
  if (syncInterval !== undefined) setConfig('sync_interval', syncInterval);
  res.json({ ok: true });
});

// ---------- Sync ----------

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

app.post('/api/sync', (_req, res) => {
  sync();
  res.json({ ok: true, message: 'Sync started' });
});

app.post('/api/sync/cancel', (_req, res) => {
  cancelSync();
  res.json({ ok: true, message: 'Sync cancelled' });
});

app.post('/api/crawl', (_req, res) => {
  startCrawl();
  res.json({ ok: true, message: 'Crawl started' });
});

app.post('/api/crawl/cancel', (_req, res) => {
  cancelCrawl();
  res.json({ ok: true, message: 'Crawl cancelled' });
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

// SPA fallback: serve index.html with no-cache so deploys are picked up immediately
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---------- Start ----------

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
});

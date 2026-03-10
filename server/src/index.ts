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
} from './db.js';
import { getStatus, sync, cancelSync, startupSync } from './sync.js';
import { fetchXtreamStreamsByCategory, fetchXtreamShortEpg, fetchAllCategoryStreams } from './xtream.js';
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

  // If a specific group is requested and we're in xtream mode, try on-demand fetch
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  if (group && group !== 'All' && inputMode === 'xtream') {
    const category = getCategoryByName(group);
    if (category) {
      const isExpired = !category.fetched_at || (Date.now() - category.fetched_at) > CACHE_TTL_MS;
      if (isExpired) {
        const config = getXtreamConfig();
        if (config) {
          const hasCachedData = !!category.fetched_at;
          if (hasCachedData) {
            // Serve stale cache immediately, refresh in background
            const reason = 'cache expired';
            logger.info(`Background refresh for "${group}" (${category.id}) — ${reason}`);
            fetchXtreamStreamsByCategory(config, category.id, category.name).then(channels => {
              saveChannelsForCategory(category.id, channels);
              markCategoryFetched(category.id, channels.length);
              logger.info(`Background refresh done for "${group}": ${channels.length} streams`);
            }).catch(err => {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              logger.error(`Background refresh failed for "${group}": ${msg}`);
            });
          } else {
            // No cached data at all — must fetch synchronously
            try {
              logger.info(`On-demand fetch for "${group}" (${category.id}) — not cached`);
              const channels = await fetchXtreamStreamsByCategory(config, category.id, category.name);
              saveChannelsForCategory(category.id, channels);
              markCategoryFetched(category.id, channels.length);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              logger.error(`Failed to fetch streams for "${group}": ${msg}`);
              res.status(502).json({ error: `Failed to fetch streams: ${msg}` });
              return;
            }
          }
        }
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

// ---------- Search ----------

// Track ongoing fetch-all operations to avoid duplicates
const fetchAllInProgress = new Set<string>();

app.get('/api/search', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  const contentType = req.query.type as string | undefined;
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
  const dbChannels = searchChannelsByName(q, contentType);
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

// ---------- Stream Proxy ----------
// Proxies stream URLs through the server so mobile clients don't need
// direct access to the Xtream server (avoids CORS and network issues).

app.get('/api/stream/:channelId', async (req, res) => {
  const channel = getChannelById(req.params.channelId);
  if (!channel || !channel.url) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  // For live TV, append .m3u8 to get HLS format (browser-compatible)
  let streamUrl = channel.url;
  const isLiveTs = channel.content_type === 'livetv' && !streamUrl.match(/\.\w{2,4}($|\?)/);
  if (isLiveTs) {
    streamUrl += '.m3u8';
  }

  try {
    const upstream = await fetch(streamUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'StreamVault/1.0' },
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
      return;
    }

    // Forward content type
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = ct || '';
    const isM3u8 = contentType.includes('mpegurl') || contentType.includes('m3u') || streamUrl.endsWith('.m3u8');

    if (isM3u8) {
      // Rewrite HLS playlist: make segment URLs absolute through our proxy
      const body = await upstream.text();
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const rewritten = body.replace(/^(?!#)(\S+)/gm, (line: string) => {
        if (line.startsWith('http://') || line.startsWith('https://')) {
          return `/api/proxy?url=${encodeURIComponent(line)}`;
        }
        // Relative URL — make it absolute through proxy
        return `/api/proxy?url=${encodeURIComponent(baseUrl + line)}`;
      });
      res.send(rewritten);
    } else {
      // Binary stream — pipe directly
      if (!upstream.body) {
        res.status(502).json({ error: 'No response body' });
        return;
      }
      const nodeStream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
      nodeStream.pipe(res);
      req.on('close', () => {
        nodeStream.destroy();
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stream proxy error';
    logger.error(`Stream proxy failed for ${req.params.channelId}: ${msg}`);
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
  }
});

// Generic URL proxy for HLS segments
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'url parameter required' });
    return;
  }

  try {
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'StreamVault/1.0' },
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
      return;
    }

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');

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

// ---------- Serve frontend (PWA) ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'public');

// Serve static files with caching for immutable assets
app.use(express.static(FRONTEND_DIR, {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    // Fingerprinted assets get long cache
    if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// SPA fallback: serve index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---------- Start ----------

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
});

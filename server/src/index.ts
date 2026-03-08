import express from 'express';
import cors from 'cors';
import {
  getChannels, getChannelsByGroup, getGroups, getRegions,
  getPrograms, getConfig, setConfig,
  getCategories, getCategoryByName, getContentTypeCounts,
  saveChannelsForCategory, markCategoryFetched,
} from './db.js';
import { getStatus, sync, cancelSync, startupSync } from './sync.js';
import { fetchXtreamStreamsByCategory, fetchXtreamShortEpg } from './xtream.js';
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
  const inputMode = getConfig('input_mode', 'manual');

  // If a specific group is requested and we're in xtream mode, try on-demand fetch
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  if (group && group !== 'All' && inputMode === 'xtream') {
    const category = getCategoryByName(group);
    if (category) {
      const isExpired = !category.fetched_at || (Date.now() - category.fetched_at) > CACHE_TTL_MS;
      if (isExpired) {
        const config = getXtreamConfig();
        if (config) {
          try {
            const reason = category.fetched_at ? 'cache expired' : 'not cached';
            logger.info(`On-demand fetch for "${group}" (${category.id}) — ${reason}`);
            const channels = await fetchXtreamStreamsByCategory(config, category.id, category.name);
            saveChannelsForCategory(category.id, channels);
            markCategoryFetched(category.id, channels.length);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            logger.error(`Failed to fetch streams for "${group}": ${msg}`);
            // If we have stale cache, serve it rather than error
            if (category.fetched_at) {
              logger.warn(`Serving stale cache for "${group}"`);
            } else {
              res.status(502).json({ error: `Failed to fetch streams: ${msg}` });
              return;
            }
          }
        }
      }
    }
  }

  // Return channels from DB
  const dbChannels = group && group !== 'All'
    ? getChannelsByGroup(group)
    : getChannels();

  const channels = dbChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
    isFavorite: false,
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
  res.json({ channels, groups, regions, contentTypeCounts });
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

// ---------- Start ----------

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
});

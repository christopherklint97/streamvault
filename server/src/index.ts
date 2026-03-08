import express from 'express';
import cors from 'cors';
import {
  getChannels, getGroups, getRegions,
  getPrograms, getConfig, setConfig,
} from './db.js';
import { getStatus, sync, cancelSync, startupSync } from './sync.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json());

// ---------- Channels ----------

app.get('/api/channels', (_req, res) => {
  const channels = getChannels().map(ch => ({
    id: ch.id,
    name: ch.name,
    url: ch.url,
    logo: ch.logo,
    group: ch.grp,
    region: ch.region,
    contentType: ch.content_type,
    isFavorite: false,
  }));
  const groups = ['All', ...getGroups()];
  const regions = ['All', ...getRegions()];
  res.json({ channels, groups, regions });
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

// ---------- Config (sources + sync interval) ----------

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
  console.log(`StreamVault server listening on http://0.0.0.0:${PORT}`);
  startupSync();
});

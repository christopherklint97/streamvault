import { Router } from 'express';
import type { ArchiveStore } from './archive-store.js';
import type { DBRecording } from './db.js';
import { createArchiveTicket, verifyArchiveTicket, buildArchiveVod, archiveGaps,
  playableStart, playableEnd, playableDuration } from './archive-hls.js';
import { requireAuth } from './security.js';
import { pruneArchive } from './archive-retention.js';
import fs from 'node:fs';
import path from 'node:path';

// Native finite HLS players do not renew a playlist ticket while paused or
// scrubbing. A 26h lease pins up to one 24h window plus a two-hour margin.
// Storage operators must budget pinned bytes above the ordinary retention cap.
const LEASE_MS = 26 * 60 * 60_000;
const MAX_LEASE_MS = 26 * 60 * 60_000;
export function createArchiveRouter(deps: {
  store: ArchiveStore; root: string; secret: Buffer;
  getChannel: (id: string) => { id: string; name: string; content_type: string } | undefined;
  getRecording: (id: string) => DBRecording | undefined;
  getPrograms: (id: string, from: number, to: number) => Array<{ title: string; startTime: number; endTime: number }>;
  start: (channelId: string) => void; stop: (channelId: string) => Promise<void>;
  prioritize?: (channelId: string, startTime: number, endTime: number) => void;
}) {
  const { store, root, secret } = deps;
  const router = Router();
  const view = (channelId: string) => {
    const row = store.getArchive(channelId);
    if (!row) return undefined;
    // Legacy rows may still contain credential-bearing FFmpeg stderr. The
    // database error is diagnostic-only and must never be returned to clients.
    const error = row.status === 'storage_low' ? 'Archive storage low or unavailable' :
      row.status === 'retrying' ? 'Archive source disconnected; reconnecting' : null;
    return { ...row, error, enabled: row.enabled === 1, ...store.coverage(channelId) };
  };
  router.get('/api/archives', requireAuth, (_req, res) => {
    res.json({ archives: store.archives().map(row => view(row.channelId)) });
  });
  router.get('/api/archives/:channelId/programs', requireAuth, (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!store.getArchive(String(req.params.channelId))) { res.status(404).end(); return; }
    if (!/^\d+$/.test(String(req.query.from)) || !/^\d+$/.test(String(req.query.to)) ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > 24 * 3_600_000) {
      res.status(400).json({ error: 'Provide a bounded UTC millisecond from/to window (max 24h)' }); return;
    }
    res.set('Cache-Control', 'private, no-store').json({ programs: deps.getPrograms(String(req.params.channelId), from, to) });
  });
  router.put('/api/archives/:channelId', requireAuth, async (req, res) => {
    const channelId = String(req.params.channelId);
    const channel = deps.getChannel(channelId);
    const { enabled, retentionHours, channelName } = req.body ?? {};
    if (!channel || channel.content_type !== 'livetv' || typeof enabled !== 'boolean' ||
      !Number.isSafeInteger(retentionHours) || retentionHours < 1 || retentionHours > 168 ||
      (channelName !== undefined && (typeof channelName !== 'string' || channelName.length > 200))) {
      res.status(400).json({ error: 'Valid live channel, enabled boolean and retentionHours (1–168) required' }); return;
    }
    // Persist disable before awaiting writer/repair shutdown, so an in-flight
    // derivative cannot publish while the disable request is pending.
    store.configure(channelId, channel.name, enabled, retentionHours);
    if (!enabled) {
      await deps.stop(channelId);
      store.setStatus(channelId, 'stopped');
    } else deps.start(channelId);
    // Apply a shortened policy now; deletion respects active viewer pins.
    pruneArchive(store, root, channelId);
    res.json({ archive: view(channelId) });
  });
  router.post('/api/archive/:channelId/playback-ticket', requireAuth, (req, res) => {
    const channelId = String(req.params.channelId);
    const { startTime, endTime } = req.body ?? {};
    const archive = store.getArchive(channelId);
    if (!archive || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) ||
      startTime < 0 || endTime <= startTime || endTime - startTime > archive.retentionHours * 3_600_000 ||
      endTime - startTime > 24 * 3_600_000) {
      res.status(400).json({ error: 'Invalid archive interval' }); return;
    }
    const now = Date.now();
    const selected = store.overlap(channelId, startTime, endTime);
    if (!selected.length) { res.status(404).json({ error: 'No published archive coverage' }); return; }
    const effectiveStart = playableStart(selected[0]);
    const effectiveEnd = playableEnd(selected.at(-1)!);
    const expiresAt = now + LEASE_MS;
    const snapshot = store.createSnapshot(channelId, startTime, endTime, now, expiresAt);
    deps.prioritize?.(channelId, startTime, endTime);
    const ticket = createArchiveTicket(snapshot.id, secret, expiresAt);
    res.set('Cache-Control', 'no-store').json({ url: `/api/archive/snapshots/${snapshot.id}/index.m3u8?ticket=${ticket}`,
      snapshotId: snapshot.id, expiresAt, startTime: effectiveStart, endTime: effectiveEnd,
      startOffsetSeconds: Math.max(0, Math.min(playableDuration(snapshot.chunks[0]), (startTime - effectiveStart) / 1000)),
      renewUrl: `/api/archive/snapshots/${snapshot.id}/renew`, maxExpiresAt: now + MAX_LEASE_MS,
      duration: snapshot.chunks.reduce((sum, chunk) => sum + playableDuration(chunk), 0),
      gaps: archiveGaps(snapshot.chunks, effectiveStart, effectiveEnd) });
  });
  router.post('/api/archive/snapshots/:snapshotId/renew', requireAuth, (req, res) => {
    const id = String(req.params.snapshotId);
    const snapshot = store.renewSnapshot(id, Date.now(), LEASE_MS, MAX_LEASE_MS);
    if (!snapshot) { res.status(410).json({ error: 'Snapshot expired; request a new playback ticket for currently available coverage' }); return; }
    const ticket = createArchiveTicket(id, secret, snapshot.expiresAt);
    res.set('Cache-Control', 'no-store').json({ url: `/api/archive/snapshots/${id}/index.m3u8?ticket=${ticket}`,
      snapshotId: id, expiresAt: snapshot.expiresAt, maxExpiresAt: snapshot.createdAt + MAX_LEASE_MS });
  });
  router.get('/api/archive/snapshots/:snapshotId/index.m3u8', (req, res) => {
    const id = String(req.params.snapshotId);
    if (!verifyArchiveTicket(req.query.ticket, id, secret)) { res.status(401).end(); return; }
    const snapshot = store.snapshot(id);
    if (!snapshot || snapshot.expiresAt <= Date.now()) { res.status(410).end(); return; }
    const token = String(req.query.ticket);
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'private, no-store').send(buildArchiveVod(snapshot.chunks,
      chunkId => `/api/archive/chunks/${encodeURIComponent(chunkId)}.ts?snapshot=${encodeURIComponent(id)}&ticket=${encodeURIComponent(token)}`));
  });
  router.get('/api/archive/chunks/:chunkId.ts', (req, res) => {
    const id = String(req.query.snapshot ?? '');
    if (!verifyArchiveTicket(req.query.ticket, id, secret)) { res.status(401).end(); return; }
    const snapshot = store.snapshot(id);
    if (!snapshot || snapshot.expiresAt <= Date.now()) { res.status(410).end(); return; }
    const chunk = snapshot.chunks.find(c => c.id === req.params.chunkId);
    if (!chunk) { res.status(404).end(); return; }
    const absolute = path.resolve(root, chunk.playbackPath ?? chunk.path);
    try {
      if (!absolute.startsWith(path.resolve(root) + path.sep) ||
        !(chunk.playbackPath ?? chunk.path).endsWith('.ts') ||
        !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(absolute).isFile()) {
        res.status(404).end(); return;
      }
      res.type('video/mp2t').set('Cache-Control', 'private, no-store').sendFile(absolute, { dotfiles: 'allow' });
    } catch { res.status(404).end(); }
  });
  router.post('/api/recordings/:id/hls-ticket', requireAuth, (req, res) => {
    const recording = deps.getRecording(String(req.params.id));
    if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
    if (recording.capture_format !== 'segmented') {
      res.status(409).json({ error: 'Recording uses legacy file playback' }); return;
    }
    if (recording.status !== 'completed') { res.status(409).json({ error: 'Recording is not complete' }); return; }
    const now = Date.now();
    const expiresAt = now + LEASE_MS;
    let snapshot;
    try {
      snapshot = store.createRecordingSnapshot(recording.id, recording.channel_id, recording.start_time, recording.end_time, now, expiresAt);
    } catch { res.status(404).json({ error: 'Saved segments are unavailable' }); return; }
    const first = snapshot.chunks[0];
    const ticket = createArchiveTicket(snapshot.id, secret, expiresAt);
    res.set('Cache-Control', 'no-store').json({ url: `/api/archive/snapshots/${snapshot.id}/index.m3u8?ticket=${ticket}`,
      snapshotId: snapshot.id, expiresAt, maxExpiresAt: now + MAX_LEASE_MS,
      renewUrl: `/api/archive/snapshots/${snapshot.id}/renew`,
      startTime: playableStart(first), endTime: playableEnd(snapshot.chunks.at(-1)!),
      startOffsetSeconds: Math.max(0, Math.min(playableDuration(first), (recording.start_time - playableStart(first)) / 1000)),
      duration: snapshot.chunks.reduce((sum, chunk) => sum + playableDuration(chunk), 0),
      gaps: archiveGaps(snapshot.chunks, playableStart(first), playableEnd(snapshot.chunks.at(-1)!)) });
  });
  return router;
}

import { it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { createArchiveRouter } from './archive-routes.js';
import type { DBRecording } from './db.js';

it('issues finite scoped playback and denies cross-snapshot and forged segment requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-api-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db);
  let recording: DBRecording | undefined;
  const prioritize = vi.fn();
  const stop = vi.fn(async (id: string) => {
    expect(store.getArchive(id)?.enabled).toBeFalsy();
  });
  const app = express(); app.use(express.json());
  app.use(createArchiveRouter({ store, root, secret: Buffer.alloc(32, 2), getChannel: id => id === 'c' ? { id: 'c', name: 'C', content_type: 'livetv' } : undefined,
    start: () => {}, stop, prioritize, getRecording: id => id === recording?.id ? recording : undefined,
    getPrograms: () => [{ title: 'Show', startTime: 1000, endTime: 21000 }] }));
  const server = app.listen(0);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const base = `http://127.0.0.1:${address.port}`;
    const put = await fetch(`${base}/api/archives/c`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, retentionHours: 24, channelName: 'C' }) });
    expect(put.status).toBe(200);
    const list = await fetch(`${base}/api/archives`).then(r => r.json()) as { archives: Array<{ channelId: string }> };
    expect(list.archives[0].channelId).toBe('c');
    // Legacy rows may already have raw FFmpeg stderr persisted by an older build.
    store.setStatus('c', 'retrying', 'https://user:synthetic-secret@provider.example/stream?token=synthetic-secret');
    const safeList = await fetch(`${base}/api/archives`).then(r => r.json()) as { archives: Array<{ error: string | null }> };
    expect(safeList.archives[0].error).toBe('Archive source disconnected; reconnecting');
    expect(JSON.stringify(safeList)).not.toContain('synthetic-secret');
    const safeUpdate = await fetch(`${base}/api/archives/c`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, retentionHours: 24 }) });
    expect((await safeUpdate.text())).not.toContain('synthetic-secret');
    const guide = await fetch(`${base}/api/archives/c/programs?from=1000&to=21000`);
    expect(guide.status).toBe(200);
    expect(await guide.json()).toEqual({ programs: [{ title: 'Show', startTime: 1000, endTime: 21000 }] });
    expect((await fetch(`${base}/api/archives/c/programs?from=0&to=90000000`)).status).toBe(400);
    fs.writeFileSync(path.join(root, 'one.ts'), Buffer.alloc(188, 0x47));
    store.publish({ id: 'one', channelId: 'c', start: 1000, end: 21000, duration: 20, path: 'one.ts', size: 188, epoch: 1 });
    recording = { id: 'saved', channel_id: 'c', start_time: 5000, end_time: 16000,
      capture_format: 'segmented', status: 'completed' } as DBRecording;
    store.addRecordingRef('saved', 'one');
    const show = await fetch(`${base}/api/recordings/saved/hls-ticket`, { method: 'POST' });
    expect(show.status).toBe(200);
    expect((await show.json() as { startOffsetSeconds: number }).startOffsetSeconds).toBe(4);
    expect(prioritize).not.toHaveBeenCalled();
    const response = await fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startTime: 1000, endTime: 21000 }) });
    expect(response.status).toBe(200);
    expect(prioritize).toHaveBeenCalledWith('c', 1000, 21000);
    const ticket = await response.json() as { url: string; snapshotId: string; duration: number; expiresAt: number };
    expect(ticket.expiresAt - Date.now()).toBeGreaterThan(25 * 3_600_000);
    const tooWide = await fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: 1000, endTime: 1000 + 24 * 3_600_000 + 1 }) });
    expect(tooWide.status).toBe(400);
    expect(ticket.duration).toBe(20);
    expect((ticket as { startOffsetSeconds?: number }).startOffsetSeconds).toBe(0);
    const clipped = await fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startTime: 5000, endTime: 16000 }) });
    expect((await clipped.json() as { startOffsetSeconds: number }).startOffsetSeconds).toBe(4);
    const renewal = await fetch(`${base}/api/archive/snapshots/${ticket.snapshotId}/renew`, { method: 'POST' });
    expect(renewal.status).toBe(200);
    expect((await renewal.json() as { url: string }).url).toContain(ticket.snapshotId);
    const playlist = await fetch(base + ticket.url).then(r => r.text());
    expect(playlist).toContain('#EXT-X-ENDLIST');
    const segment = playlist.split('\n').find(line => line.startsWith('/api/archive/chunks/'))!;
    const segmentResponse = await fetch(base + segment);
    expect(segmentResponse.status).toBe(200);
    expect((await segmentResponse.arrayBuffer()).byteLength).toBe(188);
    expect((await fetch(base + segment.replace(/ticket=.*/, 'ticket=forged'))).status).toBe(401);
    expect((await fetch(base + segment.replace('one.ts', 'other.ts'))).status).toBe(404);
    store.configure('other', 'Other', true, 24);
    fs.writeFileSync(path.join(root, 'two.ts'), Buffer.alloc(188, 0x47));
    store.publish({ id: 'two', channelId: 'other', start: 1000, end: 21000, duration: 20, path: 'two.ts', size: 188, epoch: 1 });
    expect((await fetch(base + segment.replace('/one.ts', '/two.ts'))).status).toBe(404);
    vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', 'c');
    prioritize.mockClear();
    const canary = await fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: 1000, endTime: 21000 }) });
    expect(canary.status).toBe(200);
    expect(prioritize).toHaveBeenCalledWith('c', 1000, 21000);
    vi.unstubAllEnvs();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(ticket.expiresAt - 3_600_000);
    try {
      expect((await fetch(base + ticket.url)).status).toBe(200);
      expect((await fetch(base + segment)).status).toBe(200);
      expect(store.prunable('c', Number.MAX_SAFE_INTEGER, Date.now()).map(c => c.id)).not.toContain('one');
    } finally { clock.mockRestore(); }
    const disabled = await fetch(`${base}/api/archives/c`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, retentionHours: 24 }) });
    expect(disabled.status).toBe(200);
    expect(stop).toHaveBeenCalledWith('c');
  } finally { vi.unstubAllEnvs(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('serves prior raw masters and hidden chunks to new archive tickets when emergency fallback is enabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-raw-api-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
  const app = express(); app.use(express.json());
  app.use(createArchiveRouter({ store, root, secret: Buffer.alloc(32, 4), getChannel: id => id === 'c' ? { id: 'c', name: 'C', content_type: 'livetv' } : undefined,
    start: () => {}, stop: async () => {}, getRecording: () => undefined, getPrograms: () => [] }));
  const server = app.listen(0);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const base = `http://127.0.0.1:${address.port}`;
    for (const [id, start] of [['first', 1_000], ['hidden', 21_000], ['joined', 41_000]] as const) {
      fs.writeFileSync(path.join(root, `${id}.ts`), `RAW-${id}`);
      store.publish({ id, channelId: 'c', start, end: start + 20_000, duration: 20,
        path: `${id}.ts`, size: `RAW-${id}`.length, epoch: id === 'joined' ? 2 : 1 });
    }
    fs.writeFileSync(path.join(root, 'joined.playback.ts'), 'REPAIRED');
    expect(store.hidePlaybackDuplicate('hidden')).toBe(true);
    expect(store.setPlaybackMedia('joined', 'joined.playback.ts', 8, 5, 15, Date.now())).toBe(true);
    const ticket = () => fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startTime: 1_000, endTime: 61_000 }) }).then(r => r.json()) as Promise<{ url: string; snapshotId: string; duration: number; endTime: number }>;
    const prior = await ticket();
    expect(store.snapshot(prior.snapshotId)?.chunks.map(c => c.id)).toEqual(['first', 'joined']);
    vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    const fallback = await ticket();
    expect(fallback.duration).toBe(60);
    expect(fallback.endTime).toBe(61_000);
    expect(store.snapshot(fallback.snapshotId)?.chunks.map(c => c.id)).toEqual(['first', 'hidden', 'joined']);
    expect(store.snapshot(fallback.snapshotId)?.chunks.every(c => !c.playbackPath)).toBe(true);
    const playlist = await fetch(base + fallback.url).then(r => r.text());
    const joinedUrl = playlist.split('\n').find(line => line.includes('/joined.ts?'))!;
    expect(await fetch(base + joinedUrl).then(r => r.text())).toBe('RAW-joined');
    expect(store.snapshot(prior.snapshotId)?.chunks.at(-1)?.playbackPath).toBe('joined.playback.ts');
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

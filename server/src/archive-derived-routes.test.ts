import { it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { createArchiveRouter } from './archive-routes.js';

it('serves the pinned derivative through finite seekable HLS while retaining the raw TS', async () => {
  // This fixture exercises the legacy derivative path, not the default raw+pair mode.
  vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-derived-route-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
  fs.writeFileSync(path.join(root, 'raw.ts'), Buffer.alloc(188, 1));
  fs.writeFileSync(path.join(root, 'raw.playback.ts'), Buffer.alloc(376, 2));
  store.publish({ id: 'raw', channelId: 'one', start: 1000, end: 21_000,
    duration: 20, size: 188, path: 'raw.ts', epoch: 1 });
  expect(store.setPlaybackMedia('raw', 'raw.playback.ts', 376, 3, 17, Date.now())).toBe(true);
  expect(store.coverage('one')).toMatchObject({ availableFrom: 4000, availableTo: 21_000,
    diskUsageBytes: 564 });
  const app = express(); app.use(express.json()); app.use(createArchiveRouter({ store, root,
    secret: Buffer.alloc(32, 4), getChannel: () => undefined, getRecording: () => undefined,
    getPrograms: () => [], start: () => {}, stop: async () => {} }));
  const server = app.listen(0);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (startTime: number, endTime: number) => fetch(`${base}/api/archive/one/playback-ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime, endTime }),
    });
    expect((await request(1500, 3500)).status).toBe(404); // Entire interval was verified duplicate media.
    const spanning = await request(3000, 8000);
    expect(spanning.status).toBe(200);
    expect(await spanning.json()).toMatchObject({ startTime: 4000, startOffsetSeconds: 0 });
    const inside = await request(5000, 8000);
    expect(inside.status).toBe(200);
    expect(await inside.json()).toMatchObject({ startTime: 4000, startOffsetSeconds: 1 });
    const response = await fetch(`${base}/api/archive/one/playback-ticket`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startTime: 1000, endTime: 21_000 }) });
    expect(response.status).toBe(200);
    const ticket = await response.json() as { url: string; duration: number; startTime: number; startOffsetSeconds: number };
    expect(ticket).toMatchObject({ duration: 17, startTime: 4000, startOffsetSeconds: 0 });
    const playlist = await fetch(base + ticket.url).then(r => r.text());
    expect(playlist).toContain('#EXTINF:17.000,');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    const segment = playlist.split('\n').find(line => line.startsWith('/api/archive/chunks/'))!;
    const served = await fetch(base + segment);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBe(376);
    expect(fs.statSync(path.join(root, 'raw.ts')).size).toBe(188);
  } finally { vi.unstubAllEnvs(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

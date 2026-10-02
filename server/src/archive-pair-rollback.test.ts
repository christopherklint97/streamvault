import { it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { createArchiveRouter } from './archive-routes.js';

it('removing a pair canary restores raw selection for new tickets without changing old pins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-rollback-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
  const priorId = '11111111-1111-4111-8111-111111111111-chunk-000000006.ts';
  const nextId = '22222222-2222-4222-8222-222222222222-chunk-000000000.ts';
  for (const [id, start, end, epoch] of [[priorId, 1000, 21000, 1], [nextId, 9000, 29000, 2]] as const) {
    const relative = `${id}.ts`;
    fs.writeFileSync(path.join(root, relative), `RAW-${id}`);
    store.publish({ id, channelId: 'c', start, end, duration: 20,
      path: relative, size: `RAW-${id}`.length, epoch });
  }
  fs.writeFileSync(path.join(root, 'prior.pair.playback.ts'), 'PAIR-PRIOR');
  fs.writeFileSync(path.join(root, 'next.pair.playback.ts'), 'PAIR-NEXT');
  expect(store.publishPlaybackPair({ priorId, nextId, priorRawPath: `${priorId}.ts`,
    nextRawPath: `${nextId}.ts`, priorPath: 'prior.pair.playback.ts', priorSize: 10, priorCut: 13,
    nextPath: 'next.pair.playback.ts', nextSize: 9, nextOffset: 6, nextDuration: 14 })).toBe(true);
  const app = express(); app.use(express.json());
  app.use(createArchiveRouter({ store, root, secret: Buffer.alloc(32, 4),
    getChannel: id => id === 'c' ? { id: 'c', name: 'C', content_type: 'livetv' } : undefined,
    start: () => {}, stop: async () => {}, getRecording: () => undefined, getPrograms: () => [] }));
  const server = app.listen(0);
  vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
  vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', 'c');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const base = `http://127.0.0.1:${address.port}`;
    const ticket = async () => {
      const response = await fetch(`${base}/api/archive/c/playback-ticket`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: 1000, endTime: 29000 }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ url: string; snapshotId: string }>;
    };
    const coverage = async (): Promise<number> => {
      const response = await fetch(`${base}/api/archives`);
      expect(response.status).toBe(200);
      const body = await response.json() as { archives: Array<{ availableTo: number }> };
      return body.archives[0].availableTo;
    };
    const canary = await ticket();
    expect(await coverage()).toBe(28_000);
    expect(store.snapshot(canary.snapshotId)?.chunks.every(c => c.playbackPath?.endsWith('.playback.ts'))).toBe(true);
    vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', '');
    const rollback = await ticket();
    expect(await coverage()).toBe(29_000);
    expect(store.snapshot(rollback.snapshotId)?.chunks.every(c => !c.playbackPath)).toBe(true);
    expect(store.snapshot(canary.snapshotId)?.chunks.every(c => c.playbackPath?.endsWith('.playback.ts'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

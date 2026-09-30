import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { pruneArchive } from './archive-retention.js';

it('pins both raw and derived files, and removes both before deleting the index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-derived-retention-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 1);
  try {
    for (const file of ['raw.ts', 'raw.playback.ts']) fs.writeFileSync(path.join(root, file), 'TS DATA');
    store.publish({ id: 'raw', channelId: 'c', start: 100, end: 10_100,
      duration: 10, path: 'raw.ts', size: 7, epoch: 1 });
    expect(store.setPlaybackMedia('raw', 'raw.playback.ts', 7, 3, 7, 1)).toBe(true);
    store.createSnapshot('c', 100, 10_100, 2, 4_000_000);
    expect(pruneArchive(store, root, 'c', 3_620_000)).toBe(0);
    expect(fs.existsSync(path.join(root, 'raw.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'raw.playback.ts'))).toBe(true);
    expect(pruneArchive(store, root, 'c', 4_000_000)).toBe(1);
    expect(store.getChunk('raw')).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'raw.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'raw.playback.ts'))).toBe(false);
    expect(store.totalUsageBytes()).toBe(0);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('prunes only expired unpinned complete files and retains metadata after unlink failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-retention-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 1);
  for (const id of ['old', 'saved']) {
    fs.writeFileSync(path.join(root, `${id}.ts`), 'TS DATA');
    store.publish({ id, channelId: 'c', start: 100, end: 1000, duration: 0.9, path: `${id}.ts`, size: 7, epoch: 1 });
  }
  store.addRecordingRef('recording', 'saved');
  expect(pruneArchive(store, root, 'c', 3_602_000)).toBe(1);
  expect(store.getChunk('old')).toBeUndefined();
  expect(store.getChunk('saved')).toBeDefined();
  store.publish({ id: 'missing', channelId: 'c', start: 100, end: 1000, duration: 0.9, path: 'missing.ts', size: 7, epoch: 1 });
  expect(pruneArchive(store, root, 'c', 3_602_000)).toBe(0);
  expect(store.getChunk('missing')).toBeDefined();
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

it('rechecks ownership inside a write lock before unlinking a file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-race-'));
  const filename = path.join(root, 'old.ts'); fs.writeFileSync(filename, 'TS DATA');
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 1);
  store.publish({ id: 'old', channelId: 'c', start: 100, end: 1000, duration: 0.9, path: 'old.ts', size: 7, epoch: 1 });
  store.createSnapshot('c', 100, 1000, 3_602_000, 4_000_000);
  expect(store.pruneChunk('c', 'old', 3_602_000, () => { throw new Error('Must not unlink'); })).toBe(false);
  expect(fs.existsSync(filename)).toBe(true);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

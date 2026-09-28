import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { ArchiveCapture } from './archive-capture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('durable archive index', () => {
  it('adds restart metrics to an existing archive row without resetting capture state', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE channel_archives (
        channelId TEXT PRIMARY KEY, channelName TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        retentionHours INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL DEFAULT 'stopped',
        error TEXT, lastPublishedAt INTEGER);
        INSERT INTO channel_archives VALUES ('one','One',1,24,'capturing',NULL,12345);`);
      ensureArchiveSchema(db); ensureArchiveSchema(db);
      expect(createArchiveStore(db).getArchive('one')).toMatchObject({ status: 'capturing',
        enabled: 1, lastPublishedAt: 12345, autoRestartCount: 0,
        stalledRestartCount: 0, lastAutoRestartAt: null, lastStalledRestartAt: null,
        lastRecoveredRestartCount: 0, lastRecoveredAt: null });
    } finally { db.close(); }
  });

  it('persists restart counts and the latest stalled recovery across a database reopen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-restarts-'));
    const filename = path.join(root, 'index.sqlite');
    let db = new Database(filename); ensureArchiveSchema(db);
    try {
      let store = createArchiveStore(db);
      store.configure('one', 'One', true, 24);
      store.noteAutoRestart('one', 'source_exit', 1_000);
      store.noteAutoRestart('one', 'stalled', 2_000);
      expect(store.getArchive('one')).toMatchObject({ autoRestartCount: 2,
        stalledRestartCount: 1, lastAutoRestartAt: 2_000,
        lastStalledRestartAt: 2_000, lastAutoRestartReason: 'stalled',
        lastRecoveredRestartCount: 0 });
      store.noteRecovery('one', 3_000);
      store.noteRecovery('one', 4_000);
      expect(store.getArchive('one')).toMatchObject({ lastRecoveredRestartCount: 2, lastRecoveredAt: 3_000 });
      db.close();
      db = new Database(filename); ensureArchiveSchema(db);
      store = createArchiveStore(db);
      expect(store.getArchive('one')).toMatchObject({ autoRestartCount: 2, stalledRestartCount: 1,
        lastRecoveredRestartCount: 2, lastRecoveredAt: 3_000 });
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it('migrates twice, publishes idempotently and selects UTC overlap in order', () => {
    const db = new Database(':memory:');
    ensureArchiveSchema(db); ensureArchiveSchema(db);
    const store = createArchiveStore(db);
    store.configure('one', 'One', true, 24);
    const a = store.publish({ id: 'a', channelId: 'one', start: 1000, end: 21000, duration: 20, path: 'one/a.ts', size: 100, epoch: 1 });
    store.publish({ id: 'b', channelId: 'one', start: 22000, end: 42000, duration: 20, path: 'one/b.ts', size: 100, epoch: 1 });
    expect(store.publish({ ...a, size: 999 })).toEqual(a);
    expect(store.overlap('one', 21000, 43000).map(x => x.id)).toEqual(['b']);
    expect(store.overlap('one', 0, 43000).map(x => x.id)).toEqual(['a', 'b']);
    db.close();
  });

  it('tracks storage in a durable constant-time counter across publication and deletion', () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    store.publish({ id: 'a', channelId: 'one', start: 1, end: 1000, duration: 0.999, path: 'one/a.ts', size: 123, epoch: 1 });
    store.publish({ id: 'b', channelId: 'one', start: 1001, end: 2000, duration: 0.999, path: 'one/b.ts', size: 77, epoch: 1 });
    expect((db.prepare('SELECT bytes FROM archive_storage_usage WHERE singleton = 1').get() as { bytes: number }).bytes).toBe(200);
    store.reconcileMissing('a');
    expect(store.totalUsageBytes()).toBe(77);
    ensureArchiveSchema(db);
    expect(store.totalUsageBytes()).toBe(77);
    db.close();
  });

  it('preserves referenced chunks and active snapshot pins when pruning at exact cutoff', () => {
    const db = new Database(':memory:');
    ensureArchiveSchema(db);
    const store = createArchiveStore(db);
    store.configure('one', 'One', true, 24);
    for (const [id, end] of [['old', 1000], ['edge', 2000], ['new', 3000]] as const) {
      store.publish({ id, channelId: 'one', start: end - 900, end, duration: 0.9, path: `one/${id}.ts`, size: 100, epoch: 1 });
    }
    store.addRecordingRef('saved', 'old');
    const snapshot = store.createSnapshot('one', 0, 3100, 2500, 4000);
    expect(snapshot.chunks).toHaveLength(3);
    expect(store.prunable('one', 2000, 3000)).toEqual([]);
    store.clearExpired(4000);
    expect(store.prunable('one', 2000, 4000).map(c => c.id)).toEqual(['edge']);
    db.close();
  });
  it('reconciles a crash after unlink: drops false coverage but keeps referenced rows quarantined', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-missing-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    const dir = path.join(root, 'archive', 'one', '11111111-1111-4111-8111-111111111111'); fs.mkdirSync(dir, { recursive: true });
    try {
      for (const id of ['saved', 'pinned']) {
        const relative = `archive/one/11111111-1111-4111-8111-111111111111/${id}.ts`;
        store.publish({ id, channelId: 'one', start: 1000, end: 2000, duration: 1, path: relative, size: 100, epoch: 1 });
      }
      store.addRecordingRef('recording', 'saved');
      const pinned = store.createSnapshot('one', 1000, 2000, Date.now(), Date.now() + 100_000);
      store.publish({ id: 'loose', channelId: 'one', start: 1000, end: 2000, duration: 1,
        path: 'archive/one/11111111-1111-4111-8111-111111111111/loose.ts', size: 100, epoch: 1 });
      new ArchiveCapture(store, root, 1).recover();
      expect(store.coverage('one').availableFrom).toBeNull();
      expect(store.getChunk('loose')).toBeUndefined();
      expect(store.getChunk('saved')).toBeDefined();
      expect(store.getChunk('pinned')).toBeDefined();
      expect(store.recordingChunks('recording')).toEqual([]);
      expect(store.overlap('one', 0, 3000)).toEqual([]);
      expect(store.snapshot(pinned.id)).toBeUndefined();
      fs.writeFileSync(path.join(dir, 'saved.ts'), 'restored');
      fs.writeFileSync(path.join(dir, 'pinned.ts'), 'restored');
      new ArchiveCapture(store, root, 1).recover();
      expect(store.recordingChunks('recording').map(c => c.id)).toEqual(['saved']);
      expect(store.snapshot(pinned.id)?.chunks.map(c => c.id)).toEqual(['pinned', 'saved'].sort());
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a saved-show snapshot rather than serving a silently truncated recording', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-partial-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    try {
      for (const [id, start] of [['present', 0], ['missing', 1000]] as const) {
        fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
        if (id === 'present') fs.writeFileSync(path.join(root, 'archive', `${id}.ts`), 'TS');
        store.publish({ id, channelId: 'one', start, end: start + 1000, duration: 1,
          path: `archive/${id}.ts`, size: 100, epoch: 1 });
        store.addRecordingRef('show', id);
      }
      new ArchiveCapture(store, root, 1).recover();
      expect(store.recordingChunks('show').map(c => c.id)).toEqual(['present']);
      expect(() => store.createRecordingSnapshot('show', 'one', 0, 2000, Date.now(), Date.now() + 1000))
        .toThrow('Saved segments are unavailable');
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

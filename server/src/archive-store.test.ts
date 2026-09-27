import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';

describe('durable archive index', () => {
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
});

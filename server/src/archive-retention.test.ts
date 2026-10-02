import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { pruneArchive } from './archive-retention.js';

const priorId = 'prior-session-chunk-000000000.ts';
const nextId = 'next-session-chunk-000000000.ts';
function pairedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-retention-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('c', 'C', true, 1);
  for (const [id, start, end, name] of [
    [priorId, 100, 10_100, 'prior'], [nextId, 10_101, 20_101, 'next'],
  ] as const) {
    fs.writeFileSync(path.join(root, `${name}.ts`), 'raw data');
    fs.writeFileSync(path.join(root, `${name}.playback.ts`), 'copy');
    store.publish({ id, channelId: 'c', start, end, duration: 10,
      path: `${name}.ts`, size: 8, epoch: 1 });
  }
  expect(store.publishPlaybackPair({ priorId, nextId, priorRawPath: 'prior.ts', nextRawPath: 'next.ts',
    priorPath: 'prior.playback.ts', priorSize: 4, priorCut: 8,
    nextPath: 'next.playback.ts', nextSize: 4, nextOffset: 2, nextDuration: 8 }, 1)).toBe(true);
  return { root, db, store, close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

it('retires a pair only when both ends pass the cutoff, then prunes both raw masters', () => {
  const f = pairedFixture();
  try {
    expect(f.store.totalUsageBytes()).toBe(24);
    expect(pruneArchive(f.store, f.root, 'c', 3_620_100)).toBe(0);
    expect(f.store.getChunk(priorId)?.pairId).toBeTruthy();
    expect(f.store.totalUsageBytes()).toBe(24);
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(2);
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM archive_playback_pairs').get() as { n: number }).n).toBe(0);
    expect(f.store.getChunk(priorId)).toBeUndefined();
    expect(f.store.getChunk(nextId)).toBeUndefined();
    expect(f.store.detachedPlayback()).toEqual([]);
    expect(f.store.totalUsageBytes()).toBe(0);
    for (const name of ['prior.ts', 'next.ts', 'prior.playback.ts', 'next.playback.ts'])
      expect(fs.existsSync(path.join(f.root, name))).toBe(false);
  } finally { f.close(); }
});

it('prunes a chain of expired pairs in dependency order during one retention pass', () => {
  const f = pairedFixture();
  try {
    const tailId = 'next-session-chunk-000000001.ts';
    const thirdId = 'third-session-chunk-000000000.ts';
    for (const name of ['tail', 'third']) {
      fs.writeFileSync(path.join(f.root, `${name}.ts`), 'raw data');
      fs.writeFileSync(path.join(f.root, `${name}.playback.ts`), 'copy');
    }
    f.store.publish({ id: tailId, channelId: 'c', start: 20_102, end: 30_102,
      duration: 10, path: 'tail.ts', size: 8, epoch: 1 });
    f.store.publish({ id: thirdId, channelId: 'c', start: 30_103, end: 40_103,
      duration: 10, path: 'third.ts', size: 8, epoch: 2 });
    expect(f.store.publishPlaybackPair({ priorId: tailId, nextId: thirdId,
      priorRawPath: 'tail.ts', nextRawPath: 'third.ts', priorPath: 'tail.playback.ts',
      priorSize: 4, priorCut: 8, nextPath: 'third.playback.ts', nextSize: 4,
      nextOffset: 2, nextDuration: 8 })).toBe(true);
    expect(pruneArchive(f.store, f.root, 'c', 3_640_103)).toBe(4);
    expect(f.store.totalUsageBytes()).toBe(0);
    expect(f.store.detachedPlayback()).toEqual([]);
  } finally { f.close(); }
});

it('waits for a live pin on only one side, including at the expiry boundary', () => {
  const f = pairedFixture();
  try {
    const pin = f.store.createSnapshot('c', 9_000, 16_000, 2, 3_620_150);
    expect(pin.chunks.map(c => c.id)).toEqual([nextId]);
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(0);
    expect(f.store.getChunk(priorId)?.pairId).toBeTruthy();
    expect(f.store.getChunk(nextId)?.pairId).toBeTruthy();
    expect(f.store.totalUsageBytes()).toBe(24);
    expect(pruneArchive(f.store, f.root, 'c', 3_620_150)).toBe(2);
    expect(f.store.totalUsageBytes()).toBe(0);
  } finally { f.close(); }
});

it('rechecks retention policy and live pins under the retirement write lock', () => {
  const f = pairedFixture();
  try {
    const now = 3_620_101;
    const pairId = f.store.getChunk(priorId)!.pairId!;
    expect(f.store.retirablePairs('c', 20_101, now)).toEqual([pairId]);
    f.store.configure('c', 'C', true, 2);
    expect(f.store.retirePlaybackPair('c', pairId, now)).toBe(false);
    f.store.configure('c', 'C', true, 1);
    f.store.createSnapshot('c', 9_000, 16_000, 2, now + 100);
    expect(f.store.retirePlaybackPair('c', pairId, now)).toBe(false);
    expect(f.store.getChunk(priorId)?.playbackPath).toBe('prior.playback.ts');
    expect(f.store.detachedPlayback()).toEqual([]);
    expect(f.store.totalUsageBytes()).toBe(24);
  } finally { f.close(); }
});

it('keeps a saved show raw reference while retiring both presentation copies', () => {
  const f = pairedFixture();
  try {
    f.store.addRecordingRef('show', nextId);
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(1);
    expect(f.store.getChunk(priorId)).toBeUndefined();
    expect(f.store.getChunk(nextId)).toMatchObject({ playbackPath: null, pairId: null,
      presentationStart: null, path: 'next.ts' });
    expect(f.store.recordingChunks('show').map(c => c.id)).toEqual([nextId]);
    expect(f.store.createRecordingSnapshot('show', 'c', 10_101, 20_101, 3_620_102, 3_700_000)
      .chunks[0]).toMatchObject({ path: 'next.ts', playbackPath: null });
    expect(f.store.detachedPlayback()).toEqual([]);
    expect(f.store.totalUsageBytes()).toBe(8);
  } finally { f.close(); }
});

it('resets the shifted session tail to raw time when retiring the pair', () => {
  const f = pairedFixture();
  try {
    const tailId = 'next-session-chunk-000000001.ts';
    fs.writeFileSync(path.join(f.root, 'tail.ts'), 'raw data');
    f.store.publish({ id: tailId, channelId: 'c', start: 20_102, end: 30_102,
      duration: 10, path: 'tail.ts', size: 8, epoch: 1 });
    expect(f.store.getChunk(tailId)?.presentationStart).not.toBeNull();
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(2);
    expect(f.store.getChunk(tailId)).toMatchObject({ path: 'tail.ts', presentationStart: null });
    expect(f.store.totalUsageBytes()).toBe(8);
  } finally { f.close(); }
});

it('charges and retries a detached copy when filesystem cleanup fails', () => {
  const f = pairedFixture();
  try {
    // A directory cannot be safely unlinked as a playback file.
    fs.unlinkSync(path.join(f.root, 'next.playback.ts'));
    fs.mkdirSync(path.join(f.root, 'next.playback.ts'));
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(2);
    expect(f.store.detachedPlayback()).toEqual([{ path: 'next.playback.ts', size: 4 }]);
    expect(f.store.totalUsageBytes()).toBe(4);
    expect(fs.existsSync(path.join(f.root, 'prior.playback.ts'))).toBe(false);
    fs.rmdirSync(path.join(f.root, 'next.playback.ts'));
    fs.writeFileSync(path.join(f.root, 'next.playback.ts'), 'copy');
    expect(pruneArchive(f.store, f.root, 'c', 3_620_102)).toBe(0);
    expect(f.store.detachedPlayback()).toEqual([]);
    expect(f.store.totalUsageBytes()).toBe(0);
    expect(fs.existsSync(path.join(f.root, 'next.playback.ts'))).toBe(false);
  } finally { f.close(); }
});

it('does not treat a dangling playback symlink as verified absence', () => {
  const f = pairedFixture();
  try {
    fs.unlinkSync(path.join(f.root, 'next.playback.ts'));
    fs.symlinkSync(path.join(f.root, 'missing.ts'), path.join(f.root, 'next.playback.ts'));
    expect(pruneArchive(f.store, f.root, 'c', 3_620_101)).toBe(2);
    expect(f.store.detachedPlayback()).toEqual([{ path: 'next.playback.ts', size: 4 }]);
    expect(f.store.totalUsageBytes()).toBe(4);
    fs.unlinkSync(path.join(f.root, 'next.playback.ts'));
    pruneArchive(f.store, f.root, 'c', 3_620_102);
    expect(f.store.totalUsageBytes()).toBe(0);
  } finally { f.close(); }
});

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

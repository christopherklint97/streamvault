import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { archiveGaps, buildArchiveVod, playableStart, playableEnd } from './archive-hls.js';

function fixture(priorStart: number, nextStart: number, priorCut: number, nextOffset: number) {
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
  const priorId = 'old-chunk-000000001.ts', nextId = 'new-chunk-000000000.ts';
  const start = priorStart - 16_000;
  store.publish({ id: 'old-chunk-000000000.ts', channelId: 'one', start, end: start + 16_000, duration: 16,
    path: 'old0.ts', size: 188, epoch: 1 });
  store.publish({ id: priorId, channelId: 'one', start: priorStart, end: priorStart + 20_000, duration: 20,
    path: 'old1.ts', size: 188, epoch: 1 });
  store.publish({ id: nextId, channelId: 'one', start: nextStart, end: nextStart + 20_000, duration: 20,
    path: 'new0.ts', size: 188, epoch: 2 });
  const pair = { priorId, nextId, priorRawPath: 'old1.ts', nextRawPath: 'new0.ts',
    priorPath: 'old1.pair.playback.ts', priorSize: 180,
    priorCut, nextPath: 'new0.pair.playback.ts', nextSize: 170,
    nextOffset, nextDuration: 20 - nextOffset };
  const window = [start, nextStart + 55_000] as const;
  return { db, store, pair, window };
}

describe('verified archive pair presentation', () => {
  it('holds detached pair copies until a preexisting snapshot pin expires', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const now = Date.now();
      expect(store.publishPlaybackPair(pair)).toBe(true);
      store.createSnapshot('one', 100_000, 128_000, now, now + 60_000, true);
      expect(store.restorePlaybackPairRaw(pair.nextId, () => true)).toBe(true);
      expect(store.detachedPlayback()).toEqual([]);
      store.clearExpired(now + 60_000);
      expect(store.detachedPlayback().map(copy => copy.path).sort())
        .toEqual([pair.priorPath, pair.nextPath].sort());
    } finally { db.close(); }
  });
  it('retains seekable coverage across more than 32 consecutive verified sessions', () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    let priorId = 'session0-chunk-000000001.ts';
    store.publish({ id: priorId, channelId: 'one', start: 100_000, end: 120_000,
      duration: 20, path: 'session0-1.ts', size: 188, epoch: 0 });
    try {
      const count = process.env.STREAMVAULT_ARCHIVE_PAIR_STRESS === '1' ? 1_000 : 40;
      for (let index = 1; index <= count; index++) {
        const prior = store.getChunk(priorId)!;
        const nextId = `session${index}-chunk-000000000.ts`;
        const tailId = `session${index}-chunk-000000001.ts`;
        const start = prior.end - 12_000;
        store.publish({ id: nextId, channelId: 'one', start, end: start + 20_000,
          duration: 20, path: `session${index}-0.ts`, size: 188, epoch: index });
        store.publish({ id: tailId, channelId: 'one', start: start + 25_000,
          end: start + 45_000, duration: 20, path: `session${index}-1.ts`, size: 188, epoch: index });
        expect(store.publishPlaybackPair({ priorId, nextId, priorRawPath: prior.path,
          nextRawPath: `session${index}-0.ts`, priorPath: `session${index}-prior.playback.ts`,
          priorSize: 180, priorCut: 14, nextPath: `session${index}-next.playback.ts`,
          nextSize: 170, nextOffset: 6, nextDuration: 14 })).toBe(true);
        priorId = tailId;
      }
      const newest = store.getChunk(`session${count}-chunk-000000000.ts`)!;
      expect(store.overlap('one', newest.presentationStart! + 2_000,
        newest.presentationStart! + 3_000, true).map(c => c.id)).toContain(newest.id);
      if (process.env.STREAMVAULT_ARCHIVE_PAIR_STRESS === '1') {
        const began = performance.now();
        expect(store.createSnapshot('one', 100_000, newest.presentationStart! + 14_000,
          Date.now(), Date.now() + 60_000, true).chunks.length).toBeGreaterThan(300);
        expect(performance.now() - began).toBeLessThan(5_000);
      }
      expect(store.restorePlaybackChainRaw('session1-chunk-000000000.ts', () => true)).toBe(true);
      expect(store.getChunk(newest.id)?.pairId).toBeNull();
      expect(store.getChunk('session1-chunk-000000000.ts')?.pairId).toBeNull();
    } finally { db.close(); }
  }, 60_000);
  it('retires a later dependent pair before its source pair without corrupting the clock', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const tailId = 'new-chunk-000000001.ts';
      store.publish({ id: tailId, channelId: 'one', start: 133_000, end: 153_000,
        duration: 20, path: 'new1.ts', size: 188, epoch: 2 });
      expect(store.publishPlaybackPair({ ...pair, sessionTimeline: [
        { id: pair.nextId, presentationStart: 114_000 },
        { id: tailId, presentationStart: 128_000 },
      ] })).toBe(true);
      const firstPair = store.getChunk(pair.nextId)!.pairId!;
      const lastId = 'last-chunk-000000000.ts';
      store.publish({ id: lastId, channelId: 'one', start: 145_000, end: 165_000,
        duration: 20, path: 'last0.ts', size: 188, epoch: 3 });
      expect(store.publishPlaybackPair({ priorId: tailId, nextId: lastId,
        priorRawPath: 'new1.ts', nextRawPath: 'last0.ts',
        priorPath: 'new1.pair.playback.ts', priorSize: 180, priorCut: 14,
        nextPath: 'last0.pair.playback.ts', nextSize: 170, nextOffset: 6, nextDuration: 14
      })).toBe(true);
      const lastPair = store.getChunk(lastId)!.pairId!;
      expect(store.retirePlaybackPair('one', firstPair, 90_000_000)).toBe(false);
      expect(store.retirePlaybackPair('one', lastPair, 90_000_000)).toBe(true);
      expect(store.getChunk(tailId)?.presentationStart).toBe(128_000);
      expect(store.retirePlaybackPair('one', firstPair, 90_000_000)).toBe(true);
    } finally { db.close(); }
  });
  it('preserves a previously shifted predecessor clock across consecutive session handoffs', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const tailId = 'new-chunk-000000001.ts';
      store.publish({ id: tailId, channelId: 'one', start: 133_000, end: 153_000,
        duration: 20, path: 'new1.ts', size: 188, epoch: 2 });
      expect(store.publishPlaybackPair({ ...pair, sessionTimeline: [
        { id: pair.nextId, presentationStart: 114_000 },
        { id: tailId, presentationStart: 128_000 },
      ] })).toBe(true);
      const lastId = 'last-chunk-000000000.ts';
      store.publish({ id: lastId, channelId: 'one', start: 145_000, end: 165_000,
        duration: 20, path: 'last0.ts', size: 188, epoch: 3 });
      expect(store.publishPlaybackPair({ priorId: tailId, nextId: lastId,
        priorRawPath: 'new1.ts', nextRawPath: 'last0.ts',
        priorPath: 'new1.pair.playback.ts', priorSize: 180, priorCut: 14,
        nextPath: 'last0.pair.playback.ts', nextSize: 170, nextOffset: 6, nextDuration: 14
      })).toBe(true);
      const selected = store.createSnapshot('one', 100_000, 160_000, 1, 100, true).chunks;
      expect(selected.map(playableStart)).toEqual([100_000, 114_000, 128_000, 142_000]);
      expect(archiveGaps(selected, 100_000, 156_000)).toEqual([]);
      expect(store.reconcileMissing(pair.nextId)).toBe('quarantined');
      expect(store.overlap('one', 149_000, 151_000, true)).toEqual([]);
      expect(store.coverage('one').availableTo).toBe(100_000);
      store.markAvailable(pair.nextId);
      expect(store.overlap('one', 149_000, 151_000, true)).toHaveLength(1);
      expect(store.coverage('one').availableTo).toBe(156_000);
      expect(store.restorePlaybackPairRaw(pair.nextId, () => true)).toBe(false);
      expect(store.restorePlaybackPairRaw(lastId, () => true)).toBe(true);
      expect(store.getChunk(tailId)?.presentationStart).toBe(128_000);
      expect(store.createSnapshot('one', 100_000, 160_000, 2, 100, true).chunks
        .find(c => c.id === tailId)?.presentationStart).toBe(128_000);
      expect(store.restorePlaybackPairRaw(pair.nextId, () => true)).toBe(true);
    } finally { db.close(); }
  });
  it('does not block an unrelated archive window when a different pair is broken', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.publishPlaybackPair(pair)).toBe(true);
      db.prepare('UPDATE media_chunks SET playbackPath = NULL WHERE id = ?').run(pair.nextId);
      expect(store.overlap('one', 84_000, 99_000, true).map(c => c.id))
        .toEqual(['old-chunk-000000000.ts']);
      expect(store.createSnapshot('one', 84_000, 99_000, 1, 100, true).chunks)
        .toHaveLength(1);
      expect(store.overlap('one', 100_000, 128_000, true)).toEqual([]);
    } finally { db.close(); }
  });
  for (const [name, priorStart, nextStart, priorCut, nextOffset, shift] of [
    ['F1', 1790928588986, 1790928596674, 13.44, 13.44, -7688],
    ['ESPN', 1790939987757, 1790939995502, 14.781433, 4.771433, 2265],
  ] as const) {
    it(`${name} publishes both paths and shifts the whole successor session with pinned clock`, () => {
      const { db, store, pair, window } = fixture(priorStart, nextStart, priorCut, nextOffset);
      try {
        const old = store.createSnapshot('one', ...window, 1, 100, true);
        store.addRecordingRef('show', pair.nextId);
        const show = store.createRecordingSnapshot('show', 'one', nextStart, nextStart + 20_000, 2, 100);
        expect(store.publishPlaybackPair(pair)).toBe(true);
        const futureId = 'new-chunk-000000001.ts';
        store.publish({ id: futureId, channelId: 'one', start: nextStart + 20_000,
          end: nextStart + 40_000, duration: 20, path: 'new1.ts', size: 188, epoch: 2 });
        const selected = store.createSnapshot('one', ...window, 3, 100, true);
        expect(selected.chunks.map(c => c.id)).toEqual(['old-chunk-000000000.ts', pair.priorId, pair.nextId, futureId]);
        expect(selected.chunks.map(c => c.playbackPath)).toEqual([null, pair.priorPath, pair.nextPath, null]);
        expect(selected.chunks.map(playableStart)).toEqual([priorStart - 16_000, priorStart, priorStart + priorCut * 1000, nextStart + 20_000 + shift]);
        expect(selected.chunks.slice(1).map(c => c.playbackDuration ?? c.duration)).toEqual([priorCut, pair.nextDuration, 20]);
        expect(archiveGaps(selected.chunks, playableStart(selected.chunks[0]), playableEnd(selected.chunks.at(-1)!))).toEqual([]);
        const manifest = buildArchiveVod(selected.chunks, id => id);
        expect(manifest.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
        expect(manifest).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(priorStart + priorCut * 1000).toISOString()}`);
        expect(store.snapshot(old.id)?.chunks.every(c => !c.playbackPath && c.presentationStart == null)).toBe(true);
        expect(store.snapshot(show.id)?.chunks[0]).toMatchObject({ playbackPath: null, presentationStart: null });
        expect(store.snapshot(selected.id)?.chunks.map(playableStart)).toEqual(selected.chunks.map(playableStart));
        expect(store.coverage('one').availableTo).toBe(nextStart + 40_000 + shift);
        expect(store.totalUsageBytes()).toBe(4 * 188 + 350);
        ensureArchiveSchema(db);
        expect(store.snapshot(selected.id)?.chunks.map(playableStart)).toEqual(selected.chunks.map(playableStart));
      } finally { db.close(); }
    });
  }

  it('rejects wrong or invalid pair and leaves both rows and usage untouched', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const baseline = store.totalUsageBytes();
      for (const invalid of [
        { ...pair, nextId: 'missing' }, { ...pair, priorId: pair.nextId },
        { ...pair, priorRawPath: 'wrong.ts' }, { ...pair, nextRawPath: 'wrong.ts' },
        { ...pair, priorSize: 0 }, { ...pair, nextSize: 0 },
        { ...pair, priorCut: 21 }, { ...pair, nextOffset: 20 },
        { ...pair, nextDuration: -1 }, { ...pair, nextDuration: 20 },
      ]) expect(store.publishPlaybackPair(invalid)).toBe(false);
      expect(store.totalUsageBytes()).toBe(baseline);
      expect(store.getChunk(pair.priorId)?.playbackPath).toBeNull();
      expect(store.getChunk(pair.nextId)?.playbackPath).toBeNull();
      expect(store.createSnapshot('one', 80_000, 145_000, 1, 100, true).chunks.every(c => !c.playbackPath)).toBe(true);
    } finally { db.close(); }
  });

  it('refuses to replace an already repaired and pinned predecessor', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.setPlaybackMedia(pair.priorId, 'old1.playback.ts', 99, 2, 18, 1)).toBe(true);
      const old = store.createSnapshot('one', 80_000, 145_000, 2, 100);
      expect(store.publishPlaybackPair(pair, 2)).toBe(false);
      expect(store.snapshot(old.id)?.chunks[1].playbackPath).toBe('old1.playback.ts');
      expect(store.getChunk(pair.nextId)?.playbackPath).toBeNull();
    } finally { db.close(); }
  });

  it('supersedes an unpinned historical derivative without changing a raw or saved pin', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const oldRaw = store.createSnapshot('one', 80_000, 145_000, 1, 100, true);
      store.addRecordingRef('show', pair.priorId);
      const saved = store.createRecordingSnapshot('show', 'one', 100_000, 120_000, 1, 100);
      expect(store.setPlaybackMedia(pair.priorId, 'old1.playback.ts', 99, 2, 18, 1)).toBe(true);
      expect(store.publishPlaybackPair(pair, 2)).toBe(true);
      expect(store.snapshot(oldRaw.id)?.chunks[1].playbackPath).toBeNull();
      expect(store.snapshot(saved.id)?.chunks[0].playbackPath).toBeNull();
      expect(store.createSnapshot('one', 80_000, 145_000, 2, 100, true).chunks[1].playbackPath).toBe(pair.priorPath);
      expect(store.detachedPlayback()).toEqual([{ path: 'old1.playback.ts', size: 99 }]);
      expect(store.totalUsageBytes()).toBe(3 * 188 + 350 + 99);
      store.releaseDetachedPlayback('old1.playback.ts');
      expect(store.totalUsageBytes()).toBe(3 * 188 + 350);
    } finally { db.close(); }
  });

  it('allows superseding an expired derivative pin while keeping its old snapshot row', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.setPlaybackMedia(pair.priorId, 'old1.playback.ts', 99, 2, 18, 1)).toBe(true);
      const expired = store.createSnapshot('one', 80_000, 145_000, 1, 3);
      expect(store.publishPlaybackPair(pair, 3)).toBe(true);
      expect(store.snapshot(expired.id)).toBeUndefined();
    } finally { db.close(); }
  });

  it('marks a small raw clock discontinuity after the pair even below the ordinary gap tolerance', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.publishPlaybackPair(pair)).toBe(true);
      store.publish({ id: 'new-chunk-000000001.ts', channelId: 'one', start: 128_250,
        end: 148_250, duration: 20, path: 'new1.ts', size: 188, epoch: 2 });
      const selected = store.createSnapshot('one', 80_000, 150_000, 1, 100, true);
      expect(buildArchiveVod(selected.chunks, id => id).match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    } finally { db.close(); }
  });

  it('does not partially serve a pair when one playback path is reconciled away', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.publishPlaybackPair(pair)).toBe(true);
      const pinned = store.createSnapshot('one', 80_000, 145_000, 1, 100, true);
      store.reconcilePlaybackMissing(pair.nextId);
      expect(store.snapshot(pinned.id)).toBeUndefined();
      expect(store.overlap('one', 80_000, 145_000, true)).toEqual([]);
      expect(() => store.createSnapshot('one', 80_000, 145_000, 2, 100, true)).toThrow();
    } finally { db.close(); }
  });

  it('recovers both source rows and the successor clock only after both raw masters are validated', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      const oldRaw = store.createSnapshot('one', 80_000, 145_000, 0, 100, true);
      expect(store.publishPlaybackPair(pair)).toBe(true);
      store.publish({ id: 'new-chunk-000000001.ts', channelId: 'one', start: 128_000,
        end: 148_000, duration: 20, path: 'new1.ts', size: 188, epoch: 2 });
      const pinned = store.createSnapshot('one', 80_000, 150_000, 1, 100, true);
      store.addRecordingRef('show', pair.nextId);
      const saved = store.createRecordingSnapshot('show', 'one', 108_000, 128_000, 2, 100);
      expect(store.reconcilePlaybackMissing(pair.nextId)).toBe('pair_pending');
      expect(store.snapshot(pinned.id)).toBeUndefined();
      expect(store.restorePlaybackPairRaw(pair.nextId, path => path !== pair.priorRawPath)).toBe(false);
      expect(store.overlap('one', 80_000, 150_000, true)).toEqual([]);
      expect(store.overlap('one', 135_000, 145_000, true)).toEqual([]);
      expect(store.restorePlaybackPairRaw(pair.nextId, path => [pair.priorRawPath, pair.nextRawPath].includes(path))).toBe(true);
      expect(store.snapshot(pinned.id)).toBeUndefined();
      expect(store.snapshot(saved.id)?.chunks[0]).toMatchObject({ playbackPath: null, presentationStart: null });
      expect(store.snapshot(oldRaw.id)?.chunks.map(playableStart)).toEqual([84_000, 100_000, 108_000]);
      const restored = store.createSnapshot('one', 80_000, 150_000, 3, 100, true);
      expect(restored.chunks.map(c => c.playbackPath)).toEqual([null, null, null, null]);
      expect(restored.chunks.map(playableStart)).toEqual([84_000, 100_000, 108_000, 128_000]);
      expect(store.getChunk(pair.priorId)).toMatchObject({ playbackPath: null, pairId: null, presentationStart: null });
      expect(store.getChunk(pair.nextId)).toMatchObject({ playbackPath: null, pairId: null, presentationStart: null });
      expect(store.detachedPlayback()).toEqual([{ path: pair.priorPath, size: pair.priorSize }]);
      expect(store.totalUsageBytes()).toBe(4 * 188 + pair.priorSize);
    } finally { db.close(); }
  });

  it('rejects a changed path instead of trusting a stale pair marker', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.publishPlaybackPair(pair)).toBe(true);
      const pinned = store.createSnapshot('one', 80_000, 145_000, 1, 100, true);
      db.prepare('UPDATE media_chunks SET playbackPath = ? WHERE id = ?').run('wrong.playback.ts', pair.nextId);
      expect(store.snapshot(pinned.id)).toBeUndefined();
      expect(store.overlap('one', 80_000, 145_000, true)).toEqual([]);
      expect(() => store.createSnapshot('one', 80_000, 145_000, 2, 100, true)).toThrow();
    } finally { db.close(); }
  });

  it('rolls back the first row and pair identity if the second update aborts', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      db.exec(`CREATE TRIGGER reject_next_pair BEFORE UPDATE ON media_chunks
        WHEN NEW.id = 'new-chunk-000000000.ts' AND NEW.pairId IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'blocked'); END`);
      expect(() => store.publishPlaybackPair(pair)).toThrow();
      expect(store.getChunk(pair.priorId)).toMatchObject({ playbackPath: null, pairId: null });
      expect(store.getChunk(pair.nextId)).toMatchObject({ playbackPath: null, pairId: null });
      expect((db.prepare('SELECT count(*) AS count FROM archive_playback_pairs').get() as { count: number }).count).toBe(0);
      expect(store.totalUsageBytes()).toBe(3 * 188);
    } finally { db.close(); }
  });

  it('does not prune one half of a live pair before its pair model is retired', () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    try {
      expect(store.publishPlaybackPair(pair)).toBe(true);
      const now = 26 * 3_600_000 + 200_000;
      expect(store.pruneChunk('one', pair.priorId, now, () => { throw new Error('should not unlink'); })).toBe(false);
      expect(store.restorePlaybackPairRaw(pair.nextId, () => true)).toBe(true);
      expect(store.pruneChunk('one', pair.priorId, now, () => {})).toBe(true);
    } finally { db.close(); }
  });

  it('lists raw and unpinned legacy first chunks for historical pair backfill', () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    try {
      for (const [id, start] of [
        ['raw-chunk-000000000.ts', 10_000],
        ['legacy-chunk-000000000.ts', 30_000],
        ['pinned-chunk-000000000.ts', 50_000],
        ['hidden-chunk-000000000.ts', 70_000],
        ['ordinary-chunk-000000001.ts', 90_000],
      ] as const) store.publish({ id, channelId: 'one', start, end: start + 10_000,
        duration: 10, path: `${id}.ts`, size: 188, epoch: 1 });
      expect(store.setPlaybackMedia('legacy-chunk-000000000.ts', 'legacy.playback.ts', 100, 2, 8, 1)).toBe(true);
      expect(store.setPlaybackMedia('pinned-chunk-000000000.ts', 'pinned.playback.ts', 100, 2, 8, 1)).toBe(true);
      store.createSnapshot('one', 50_000, 60_000, 1, 100);
      expect(store.hidePlaybackDuplicate('hidden-chunk-000000000.ts')).toBe(true);
      expect(store.pairCandidates('one', 0, 2).map(c => c.id)).toEqual([
        'raw-chunk-000000000.ts', 'legacy-chunk-000000000.ts',
      ]);
      expect(store.pairCandidates('one', 20_000, 2).map(c => c.id)).toEqual(['legacy-chunk-000000000.ts']);
      expect(store.pairCandidates('one', 0, 100).map(c => c.id)).toEqual([
        'raw-chunk-000000000.ts', 'legacy-chunk-000000000.ts', 'pinned-chunk-000000000.ts',
      ]);
    } finally { db.close(); }
  });

  it('serializes pair publication against a second writer and rolls back on lock failure', async () => {
    const { db, store, pair } = fixture(100_000, 108_000, 14, 6);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-lock-'));
    const filename = path.join(root, 'index.sqlite');
    // Copy only the index; no media files are created or modified.
    await db.backup(filename);
    try {
      const other = new Database(filename); const writer = new Database(filename);
      try {
        other.pragma('busy_timeout = 1'); writer.pragma('busy_timeout = 1');
        const concurrent = createArchiveStore(writer);
        other.exec('BEGIN IMMEDIATE');
        expect(() => concurrent.publishPlaybackPair(pair)).toThrow();
        expect(concurrent.getChunk(pair.priorId)?.playbackPath).toBeNull();
        other.exec('ROLLBACK');
        expect(concurrent.publishPlaybackPair(pair)).toBe(true);
        expect(concurrent.publishPlaybackPair(pair)).toBe(false);
        expect(store.getChunk(pair.priorId)?.playbackPath).toBeNull();
      } finally { other.close(); writer.close(); }
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

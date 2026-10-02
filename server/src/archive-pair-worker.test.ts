import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pairEnabledFor, processArchivePair } from './archive-pair-worker.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';

function fixture(sample?: string, kind: 'f1' | 'espn' = 'f1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-worker-'));
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
  const priorId = '11111111-1111-4111-8111-111111111111-chunk-000000006.ts';
  const nextId = '22222222-2222-4222-8222-222222222222-chunk-000000000.ts';
  const raw = (id: string) => path.join('archive', 'one', id.split('-chunk-')[0],
    `chunk-${id.split('-chunk-')[1]}`);
  const prior = raw(priorId); const next = raw(nextId);
  for (const [name, relative] of [['prev.ts', prior], ['next.ts', next]]) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (sample) fs.copyFileSync(path.join(sample, name), absolute);
    else fs.writeFileSync(absolute, Buffer.alloc(188, 0x47));
  }
  const priorDuration = kind === 'espn' ? 16.349667 : sample ? 14.92 : 20;
  const nextDuration = kind === 'espn' ? 20.7207 : sample ? 21.12 : 20;
  const nextStart = kind === 'espn' ? 107_745 : sample ? 107_688 : 108_000;
  store.publish({ id: priorId, channelId: 'one', start: 100_000,
    end: Math.round(100_000 + priorDuration * 1000),
    duration: priorDuration, path: prior,
    size: fs.statSync(path.join(root, prior)).size, epoch: 1 });
  store.publish({ id: nextId, channelId: 'one', start: nextStart,
    end: Math.round(nextStart + nextDuration * 1000),
    duration: nextDuration, path: next,
    size: fs.statSync(path.join(root, next)).size, epoch: 2 });
  return { root, db, store, priorId, nextId, prior, next, close: () => {
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  } };
}

describe('bounded archive pair canary', () => {
  it('runs only for explicitly allowlisted channels while raw-master fallback is active', () => {
    expect(pairEnabledFor('live_17289', '1', 'live_17289, live_1015944')).toBe(true);
    expect(pairEnabledFor('live_17289', '1', 'live_44115')).toBe(false);
    expect(pairEnabledFor('live_17289', '0', 'live_17289')).toBe(false);
    expect(pairEnabledFor('live_17289', '1', '')).toBe(false);
  });
  it('leaves capture masters and the index untouched outside the explicit canary', async () => {
    const f = fixture();
    const previousRaw = fs.readFileSync(path.join(f.root, f.prior));
    try {
      let called = false;
      const prepare = async () => { called = true; throw new Error('must not run'); };
      const published = await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'live_17289' });
      expect(published).toBe(false);
      expect(called).toBe(false);
      expect(f.store.getChunk(f.priorId)?.playbackPath).toBeNull();
      expect(f.store.getChunk(f.nextId)?.playbackPath).toBeNull();
      expect(fs.readFileSync(path.join(f.root, f.prior))).toEqual(previousRaw);
    } finally { f.close(); }
  });
  it('publishes both immutable derivatives under one pair identity and preserves raw masters', async () => {
    const f = fixture();
    const previousRaw = fs.readFileSync(path.join(f.root, f.prior));
    try {
      const prepare = async (_previous: string, _next: string, priorOut: string, nextOut: string) => {
        fs.writeFileSync(priorOut, Buffer.alloc(188, 0x47));
        fs.writeFileSync(nextOut, Buffer.alloc(188, 0x47));
        return { cut: { videoBefore: 80, audioBefore: 120, videoAfter: 80, audioAfter: 120,
          videoOverlapStart: 0, audioOverlapStart: 0, offset: 6, previousOffset: 14,
          droppedDamagedPictures: 0 }, sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one' })).toBe(true);
      const prior = f.store.getChunk(f.priorId)!; const next = f.store.getChunk(f.nextId)!;
      expect(prior.playbackPath).toMatch(/\.pair\.playback\.ts$/);
      expect(next.playbackPath).toMatch(/\.pair\.playback\.ts$/);
      expect(prior.pairId).toBeTruthy();
      expect(next.pairId).toBe(prior.pairId);
      expect(fs.statSync(path.join(f.root, prior.playbackPath!)).size).toBe(188);
      expect(fs.statSync(path.join(f.root, next.playbackPath!)).size).toBe(188);
      expect(fs.readFileSync(path.join(f.root, f.prior))).toEqual(previousRaw);
      expect(f.store.totalUsageBytes()).toBe(4 * 188);
    } finally { f.close(); }
  });
  it('releases a replaced unpinned legacy derivative from the physical quota only after unlink', async () => {
    const f = fixture();
    try {
      const legacy = f.next.replace(/\.ts$/, '.playback.ts');
      fs.writeFileSync(path.join(f.root, legacy), Buffer.alloc(188, 0x47));
      expect(f.store.setPlaybackMedia(f.nextId, legacy, 188, 1, 19, Date.now())).toBe(true);
      const prepare = async (_previous: string, _next: string, priorOut: string, nextOut: string) => {
        fs.writeFileSync(priorOut, Buffer.alloc(188, 0x47));
        fs.writeFileSync(nextOut, Buffer.alloc(188, 0x47));
        return { cut: { videoBefore: 80, audioBefore: 120, videoAfter: 80, audioAfter: 120,
          videoOverlapStart: 0, audioOverlapStart: 0, offset: 6, previousOffset: 14,
          droppedDamagedPictures: 0 }, sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one' })).toBe(true);
      expect(fs.existsSync(path.join(f.root, legacy))).toBe(false);
      expect(f.store.detachedPlayback()).toEqual([]);
      expect(f.store.totalUsageBytes()).toBe(4 * 188);
    } finally { f.close(); }
  });
  it('does no work under a full disk reserve or exhausted indexed-media cap', async () => {
    const f = fixture();
    try {
      let called = false;
      const prepare = async () => { called = true; throw new Error('must not run'); };
      for (const [reserve, cap] of [[Number.MAX_SAFE_INTEGER, 100000], [1000, 376]]) {
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), reserve, cap,
          undefined, prepare, { rawMode: '1', allowlist: 'one' })).toBe(false);
      }
      expect(called).toBe(false);
      expect(f.store.getChunk(f.nextId)?.playbackPath).toBeNull();
    } finally { f.close(); }
  });
  it('cleans both unpublished copies if capture changes its source during preparation', async () => {
    const f = fixture();
    try {
      const prepare = async (_previous: string, next: string, priorOut: string, nextOut: string) => {
        fs.writeFileSync(priorOut, Buffer.alloc(188, 0x47));
        fs.writeFileSync(nextOut, Buffer.alloc(188, 0x47));
        fs.appendFileSync(next, 'changed');
        return { cut: { videoBefore: 80, audioBefore: 120, videoAfter: 80, audioAfter: 120,
          videoOverlapStart: 0, audioOverlapStart: 0, offset: 6, previousOffset: 14,
          droppedDamagedPictures: 0 }, sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one' })).toBe(false);
      expect(f.store.getChunk(f.priorId)?.playbackPath).toBeNull();
      expect(f.store.getChunk(f.nextId)?.playbackPath).toBeNull();
      const listed = fs.readdirSync(path.join(f.root, path.dirname(f.next)));
      expect(listed.some(name => name.endsWith('.pair.playback.ts'))).toBe(false);
    } finally { f.close(); }
  });
  it.skipIf(!process.env.STREAMVAULT_F1_SEAM_SAMPLE)(
    'publishes a real packet-verified F1 pair to a new raw-mode archive ticket', async () => {
      const sample = process.env.STREAMVAULT_F1_SEAM_SAMPLE!;
      const f = fixture(sample);
      try {
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000,
          400 * 1024 ** 3, undefined, undefined, { rawMode: '1', allowlist: 'one' })).toBe(true);
        const prior = f.store.getChunk(f.priorId)!, next = f.store.getChunk(f.nextId)!;
        expect(prior.pairId).toBeTruthy();
        expect(next.pairId).toBe(prior.pairId);
        const now = Date.now();
        const ticket = f.store.createSnapshot('one', 100_000, 130_000, now, now + 60000, true);
        expect(ticket.chunks.map(chunk => chunk.id)).toEqual([f.priorId, f.nextId]);
        expect(ticket.chunks.map(chunk => chunk.presentationStart)).toEqual([100_000, 113_440]);
        expect(ticket.chunks.every(chunk => chunk.playbackPath?.endsWith('.pair.playback.ts'))).toBe(true);
      } finally { f.close(); }
    }, 120000);
  it.skipIf(!process.env.STREAMVAULT_ESPN_SEAM_SAMPLE)(
    'publishes a real ESPN pair with distinct trimmed prior video/audio and corrected wallclock', async () => {
      const f = fixture(process.env.STREAMVAULT_ESPN_SEAM_SAMPLE!, 'espn');
      try {
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000,
          400 * 1024 ** 3, undefined, undefined, { rawMode: '1', allowlist: 'one' })).toBe(true);
        const now = Date.now();
        const ticket = f.store.createSnapshot('one', 100_000, 130_000, now, now + 60000, true);
        expect(ticket.chunks.map(chunk => chunk.id)).toEqual([f.priorId, f.nextId]);
        expect(ticket.chunks[0].presentationStart).toBe(100_000);
        expect(ticket.chunks[1].presentationStart).toBeCloseTo(114_781.433, 3);
        expect(ticket.chunks.every(chunk => chunk.playbackPath?.endsWith('.pair.playback.ts'))).toBe(true);
      } finally { f.close(); }
    }, 120000);
});

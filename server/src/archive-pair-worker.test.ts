import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pairEnabledFor, processArchivePair } from './archive-pair-worker.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';

function fixture(sample?: string, kind: 'f1' | 'espn' = 'f1', following = true, closed = true) {
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
  if (!sample) {
    const transport = (cc: number) => {
      const bytes = Buffer.alloc(2 * 188, 0xff);
      for (let i = 0; i < 2; i++) {
        const p = i * 188; bytes[p] = 0x47; bytes[p + 1] = 1;
        bytes[p + 2] = i; bytes[p + 3] = 0x10 | cc;
      }
      return bytes;
    };
    fs.writeFileSync(path.join(root, next), transport(0));
    if (following) fs.writeFileSync(path.join(path.dirname(path.join(root, next)), 'chunk-000000001.ts'), transport(1));
  } else if (following) fs.copyFileSync(path.join(sample, 'after.ts'),
    path.join(path.dirname(path.join(root, next)), 'chunk-000000001.ts'));
  store.publish({ id: priorId, channelId: 'one', start: 100_000,
    end: Math.round(100_000 + priorDuration * 1000),
    duration: priorDuration, path: prior,
    size: fs.statSync(path.join(root, prior)).size, epoch: 1 });
  store.publish({ id: nextId, channelId: 'one', start: nextStart,
    end: Math.round(nextStart + nextDuration * 1000),
    duration: nextDuration, path: next,
    size: fs.statSync(path.join(root, next)).size, epoch: 2 });
  if (following) {
    const afterPath = path.join('archive', 'one', nextId.split('-chunk-')[0], 'chunk-000000001.ts');
    const afterStart = Math.round(nextStart + nextDuration * 1000) + 5_000;
    store.publish({ id: nextId.replace('000000000.ts', '000000001.ts'), channelId: 'one',
      start: afterStart, end: afterStart + 20_000, duration: 20, path: afterPath,
      size: fs.statSync(path.join(root, afterPath)).size, epoch: 2 });
    if (closed) {
      const laterId = '33333333-3333-4333-8333-333333333333-chunk-000000000.ts';
      const laterPath = raw(laterId);
      fs.mkdirSync(path.dirname(path.join(root, laterPath)), { recursive: true });
      fs.writeFileSync(path.join(root, laterPath), Buffer.alloc(188, 0x47));
      store.publish({ id: laterId, channelId: 'one', start: afterStart + 40_000,
        end: afterStart + 60_000, duration: 20, path: laterPath,
        size: fs.statSync(path.join(root, laterPath)).size, epoch: 3 });
    }
  }
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
  it('repairs all current and future channels by default without a channel setting', () => {
    for (const id of ['live_17289', 'live_1015944', 'live_44115', 'live_future'])
      expect(pairEnabledFor(id, undefined)).toBe(true);
    expect(pairEnabledFor('live_future', '1')).toBe(true);
    expect(pairEnabledFor('live_future', '0')).toBe(false);
    expect(pairEnabledFor('', undefined)).toBe(false);
  });
  it('keeps injected allowlist controls test-only, without restricting production defaults', () => {
    for (const id of ['live_17289', 'live_1015944', 'live_44115', 'live_future'])
      expect(pairEnabledFor(id, '1', ' * ')).toBe(true);
    expect(pairEnabledFor('live_future', '1', 'live_17289, *')).toBe(true);
    expect(pairEnabledFor('live_future', '0', '*')).toBe(false);
    expect(pairEnabledFor('live_future', undefined, '*')).toBe(true);
    expect(pairEnabledFor('', '1', '*')).toBe(false);
    expect(pairEnabledFor('live_future', '1', 'live_*')).toBe(false);
    expect(pairEnabledFor('live_future', '1', '*,oops')).toBe(true);
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
  it('waits for the following source chunk before validating a session handoff', async () => {
    const f = fixture(undefined, 'f1', false);
    try {
      const prepare = async () => { throw new Error('must not prepare before following chunk'); };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(false);
    } finally { f.close(); }
  });
  it('does not publish a timeline while the successor session is still open', async () => {
    const f = fixture(undefined, 'f1', true, false);
    try {
      const prepare = async () => { throw new Error('must not prepare an open session'); };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(false);
    } finally { f.close(); }
  });
  it('rejects a successor whose video or audio presentation clock jumps despite intact TS counters', async () => {
    const f = fixture();
    try {
      const prepare = async () => { throw new Error('must not prepare a timestamp jump'); };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => false })).toBe(false);
      expect(f.store.getChunk(f.nextId)?.playbackPath).toBeNull();
    } finally { f.close(); }
  });
  it('falls back to a verified three-source copy while keeping the duplicate middle raw master', async () => {
    const f = fixture();
    const witnessId = f.priorId.replace('000000006.ts', '000000005.ts');
    const witnessPath = path.join(path.dirname(f.prior), 'chunk-000000005.ts');
    fs.copyFileSync(path.join(f.root, f.prior), path.join(f.root, witnessPath));
    f.store.publish({ id: witnessId, channelId: 'one', start: 80_000, end: 100_000,
      duration: 20, path: witnessPath, size: 188, epoch: 1 });
    const raw = fs.readFileSync(path.join(f.root, f.prior));
    const old = f.store.createSnapshot('one', 80_000, 128_000, 1, 100, true, false);
    try {
      let earlyCalled = false;
      const prepare = async () => undefined;
      const prepareEarly = async (witness: string, middle: string, next: string,
        firstOut: string, secondOut: string) => {
        earlyCalled = [witness, middle, next].every(file => fs.existsSync(file));
        fs.writeFileSync(firstOut, Buffer.alloc(188, 0x47));
        fs.writeFileSync(secondOut, Buffer.alloc(188, 0x47));
        return { cut: { videoBefore: 480, audioBefore: 450, videoAfter: 1016,
          audioAfter: 953, videoOverlapStart: 480, audioOverlapStart: 450,
          offset: 0, previousOffset: 9.6, droppedDamagedPictures: 1 },
        sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one',
          clockContinues: async () => true, transportContinues: async () => true,
          prepareEarly })).toBe(true);
      expect(earlyCalled).toBe(true);
      expect(f.store.getChunk(witnessId)).toMatchObject({ pairRole: 'prior', playbackDuration: 9.6 });
      expect(f.store.getChunk(f.priorId)).toMatchObject({ pairRole: 'middle', playbackHidden: 1 });
      expect(f.store.getChunk(f.nextId)).toMatchObject({ pairRole: 'next', playbackOffset: 0 });
      expect(fs.readFileSync(path.join(f.root, f.prior))).toEqual(raw);
      expect(f.store.snapshot(old.id)?.chunks.map(chunk => chunk.id)).toContain(f.priorId);
      const fresh = f.store.createSnapshot('one', 80_000, 129_600, 2, 100, true);
      expect(fresh.chunks.map(c => c.id)).toEqual([
        witnessId, f.nextId, f.nextId.replace('000000000.ts', '000000001.ts')]);
    } finally { f.close(); }
  });
  it('rejects a staged three-source pair if the unhidden witness changed', async () => {
    const f = fixture();
    const witnessId = f.priorId.replace('000000006.ts', '000000005.ts');
    const relative = path.join(path.dirname(f.prior), 'chunk-000000005.ts');
    fs.copyFileSync(path.join(f.root, f.prior), path.join(f.root, relative));
    f.store.publish({ id: witnessId, channelId: 'one', start: 80_000, end: 100_000,
      duration: 20, path: relative, size: 188, epoch: 1 });
    try {
      const early = async (witness: string, _middle: string, _next: string,
        first: string, second: string) => {
        fs.writeFileSync(first, Buffer.alloc(188, 0x47));
        fs.writeFileSync(second, Buffer.alloc(188, 0x47));
        fs.appendFileSync(witness, 'changed');
        return { cut: { videoBefore: 480, audioBefore: 450, videoAfter: 1016,
          audioAfter: 953, videoOverlapStart: 480, audioOverlapStart: 450,
          offset: 0, previousOffset: 9.6, droppedDamagedPictures: 1 },
        sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, async () => undefined, { rawMode: '1', allowlist: 'one',
          clockContinues: async () => true, transportContinues: async () => true,
          prepareEarly: early })).toBe(false);
      expect(f.store.getChunk(witnessId)?.pairId).toBeNull();
      expect(f.store.getChunk(f.priorId)?.playbackHidden).toBe(0);
      expect(f.store.getChunk(f.nextId)?.pairId).toBeNull();
      for (const directory of [path.dirname(relative), path.dirname(f.next)])
        expect(fs.readdirSync(path.join(f.root, directory)).some(name => name.endsWith('.pair.playback.ts')))
          .toBe(false);
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
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(true);
      const prior = f.store.getChunk(f.priorId)!; const next = f.store.getChunk(f.nextId)!;
      expect(prior.playbackPath).toMatch(/\.pair\.playback\.ts$/);
      expect(next.playbackPath).toMatch(/\.pair\.playback\.ts$/);
      expect(prior.pairId).toBeTruthy();
      expect(next.pairId).toBe(prior.pairId);
      expect(fs.statSync(path.join(f.root, prior.playbackPath!)).size).toBe(188);
      expect(fs.statSync(path.join(f.root, next.playbackPath!)).size).toBe(188);
      expect(fs.readFileSync(path.join(f.root, f.prior))).toEqual(previousRaw);
      expect(f.store.totalUsageBytes()).toBe(1504);
    } finally { f.close(); }
  });
  it('plans a successor against the predecessor’s shifted presentation clock', async () => {
    const f = fixture();
    try {
      f.db.prepare('UPDATE media_chunks SET presentationStart = ? WHERE id = ?').run(95_000, f.priorId);
      const prepare = async (_previous: string, _next: string, priorOut: string, nextOut: string) => {
        fs.writeFileSync(priorOut, Buffer.alloc(188, 0x47));
        fs.writeFileSync(nextOut, Buffer.alloc(188, 0x47));
        return { cut: { videoBefore: 80, audioBefore: 120, videoAfter: 80, audioAfter: 120,
          videoOverlapStart: 0, audioOverlapStart: 0, offset: 6, previousOffset: 14,
          droppedDamagedPictures: 0 }, sizes: [188, 188] as [number, number] };
      };
      expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000, 100000,
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(true);
      expect(f.store.getChunk(f.priorId)?.presentationStart).toBe(95_000);
      expect(f.store.getChunk(f.nextId)?.presentationStart).toBe(109_000);
      expect(f.store.getChunk(f.nextId.replace('000000000.ts', '000000001.ts'))?.presentationStart).toBe(123_000);
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
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(true);
      expect(fs.existsSync(path.join(f.root, legacy))).toBe(false);
      expect(f.store.detachedPlayback()).toEqual([]);
      expect(f.store.totalUsageBytes()).toBe(1504);
    } finally { f.close(); }
  });
  it('does no work under a full disk reserve or exhausted indexed-media cap', async () => {
    const f = fixture();
    try {
      let called = false;
      const prepare = async () => { called = true; throw new Error('must not run'); };
      for (const [reserve, cap] of [[Number.MAX_SAFE_INTEGER, 100000], [1000, 376]]) {
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), reserve, cap,
          undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(false);
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
        undefined, prepare, { rawMode: '1', allowlist: 'one', clockContinues: async () => true })).toBe(false);
      expect(f.store.getChunk(f.priorId)?.playbackPath).toBeNull();
      expect(f.store.getChunk(f.nextId)?.playbackPath).toBeNull();
      const listed = fs.readdirSync(path.join(f.root, path.dirname(f.next)));
      expect(listed.some(name => name.endsWith('.pair.playback.ts'))).toBe(false);
    } finally { f.close(); }
  });
  it.skipIf(!process.env.STREAMVAULT_F1_TWO_CHUNK_SAMPLE)(
    'publishes the reported three-source F1 replay as a finite pinned ticket, preserving old raw pins', async () => {
      const sample = process.env.STREAMVAULT_F1_TWO_CHUNK_SAMPLE!;
      const f = fixture();
      const witnessId = f.priorId.replace('000000006.ts', '000000005.ts');
      const witnessPath = path.join(path.dirname(f.prior), 'chunk-000000005.ts');
      try {
        fs.copyFileSync(path.join(sample, 'chunk2.ts'), path.join(f.root, witnessPath));
        fs.copyFileSync(path.join(sample, 'prev.ts'), path.join(f.root, f.prior));
        fs.copyFileSync(path.join(sample, 'next.ts'), path.join(f.root, f.next));
        const afterId = f.nextId.replace('000000000.ts', '000000001.ts');
        const after = f.store.getChunk(afterId)!;
        fs.copyFileSync(path.join(sample, 'after.ts'), path.join(f.root, after.path));
        f.store.publish({ id: witnessId, channelId: 'one', start: 80_000, end: 99_720,
          duration: 19.72, path: witnessPath,
          size: fs.statSync(path.join(f.root, witnessPath)).size, epoch: 1 });
        for (const [id, start, duration, relative] of [
          [f.priorId, 100_000, 11.86, f.prior], [f.nextId, 108_000, 20.32, f.next],
          [afterId, 128_320, 20, after.path],
        ] as const) f.db.prepare('UPDATE media_chunks SET start = ?, end = ?, duration = ?, size = ? WHERE id = ?')
          .run(start, start + Math.round(duration * 1000), duration,
            fs.statSync(path.join(f.root, relative)).size, id);
        const old = f.store.createSnapshot('one', 80_000, 148_320, 1, 100, true, false);
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000,
          400 * 1024 ** 3, undefined, undefined, { rawMode: '1', allowlist: 'one' })).toBe(true);
        const fresh = f.store.createSnapshot('one', 80_000, 129_600, 2, 100, true);
        expect(fresh.chunks.map(c => c.id)).toEqual([witnessId, f.nextId, afterId]);
        expect(fresh.chunks.slice(0, 2).map(c => c.playbackDuration)).toEqual([9.6, 20.32]);
        expect(f.store.getChunk(f.priorId)).toMatchObject({ pairRole: 'middle', playbackHidden: 1 });
        expect(f.store.snapshot(old.id)?.chunks.map(c => c.id)).toContain(f.priorId);
      } finally { f.close(); }
    }, 360000);
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
        const followingId = f.nextId.replace('000000000.ts', '000000001.ts');
        expect(ticket.chunks.map(chunk => chunk.id)).toEqual([f.priorId, f.nextId, followingId]);
        expect(ticket.chunks.map(chunk => chunk.presentationStart)).toEqual([100_000, 113_440, 121_120]);
        expect(ticket.chunks.slice(0, 2).every(chunk => chunk.playbackPath?.endsWith('.pair.playback.ts'))).toBe(true);
        expect(ticket.chunks[2].playbackPath).toBeNull();
      } finally { f.close(); }
    }, 120000);
  it.skipIf(!process.env.STREAMVAULT_ESPN_SEAM_SAMPLE)(
    'publishes a real ESPN pair with distinct trimmed prior video/audio and corrected wallclock', async () => {
      const f = fixture(process.env.STREAMVAULT_ESPN_SEAM_SAMPLE!, 'espn');
      try {
        expect(await processArchivePair(f.store, f.root, f.nextId, Date.now(), 1000,
          400 * 1024 ** 3, undefined, undefined, { rawMode: '1', allowlist: 'one' })).toBe(true);
        const now = Date.now();
        const ticket = f.store.createSnapshot('one', 100_000, 160_000, now, now + 60000, true);
        expect(ticket.chunks.map(chunk => chunk.id)).toEqual([
          f.priorId, f.nextId, f.nextId.replace('000000000.ts', '000000001.ts')]);
        expect(ticket.chunks[0].presentationStart).toBe(100_000);
        expect(ticket.chunks[1].presentationStart).toBeCloseTo(114_781.433, 3);
        expect(ticket.chunks[2].presentationStart).toBeCloseTo(130_730.7, 3);
        expect(ticket.chunks.slice(0, 2).every(chunk => chunk.playbackPath?.endsWith('.pair.playback.ts'))).toBe(true);
      } finally { f.close(); }
    }, 120000);
});

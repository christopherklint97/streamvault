import { describe, it, expect, vi } from 'vitest';
import { parsePublishedSegments, hlsCaptureArgs, hasArchiveReserve, hasArchiveCapacity, nextArchiveEpoch } from './archive-capture.js';
import { ArchiveCapture } from './archive-capture.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

describe('stream-copy HLS capture', () => {
  it('recovers every committed entry from an interrupted session and deletes unindexed artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-restart-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const session = '11111111-1111-4111-8111-111111111111';
    const dir = path.join(root, 'archive', 'c', session); fs.mkdirSync(dir, { recursive: true });
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 20; i++) {
      const name = `chunk-${String(i).padStart(9, '0')}.ts`;
      fs.writeFileSync(path.join(dir, name), 'TS DATA');
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(1_000_000 + i * 20_000).toISOString()}`, '#EXTINF:20,', name);
    }
    fs.writeFileSync(path.join(dir, 'current.m3u8'), lines.join('\n'));
    fs.writeFileSync(path.join(dir, 'chunk-000000020.ts'), 'uncommitted');
    new ArchiveCapture(store, root, 1).recover();
    expect(store.overlap('c', 0, Date.now() + 1000)).toHaveLength(20);
    expect(fs.existsSync(path.join(dir, 'chunk-000000020.ts'))).toBe(false);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  it('only imports completed manifest-listed chunks, never partial output', () => {
    const playlist = `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:00.000Z\n#EXTINF:19.520,\nchunk-000000001.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:19.520Z\n#EXTINF:20.040,\nchunk-000000002.ts\n`;
    expect(parsePublishedSegments(playlist)).toEqual([
      { name: 'chunk-000000001.ts', start: Date.parse('2026-09-27T12:00:00Z'), duration: 19.52, discontinuity: false },
      { name: 'chunk-000000002.ts', start: Date.parse('2026-09-27T12:00:19.520Z'), duration: 20.04, discontinuity: false },
    ]);
    const args = hlsCaptureArgs('http://127.0.0.1:3001/api/stream/one', '/tmp/archive');
    expect(args).toContain('-c'); expect(args).toContain('copy');
    expect(args.join(' ')).toContain('temp_file');
    expect(args[args.indexOf('-hls_list_size') + 1]).toBe('12');
    const auth = hlsCaptureArgs('http://127.0.0.1:3001/api/stream/one', '/tmp/archive', 'private-token');
    expect(auth.slice(auth.indexOf('-headers') + 1, auth.indexOf('-headers') + 2)).toEqual(['Authorization: Bearer private-token\r\n']);
    expect(hasArchiveReserve(6_000_000_000, 5_000_000_000)).toBe(true);
    expect(hasArchiveReserve(4_000_000_000, 5_000_000_000)).toBe(false);
    expect(hasArchiveCapacity(600, 200, 100, 500)).toBe(true);
    expect(hasArchiveCapacity(600, 300, 100, 300)).toBe(false);
    expect(hasArchiveCapacity(100, 200, 100, 500)).toBe(false);
  });

  it('parses a source discontinuity once rather than for every following segment', () => {
    const rows = parsePublishedSegments(`#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:00Z\n#EXTINF:20,\nchunk-000000000.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:01:00Z\n#EXTINF:20,\nchunk-000000001.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:01:20Z\n#EXTINF:20,\nchunk-000000002.ts`);
    expect(rows.map(r => r.discontinuity)).toEqual([false, true, false]);
    expect(rows.map(r => r.discontinuity).reduce((epochs, discontinuity) => {
      epochs.push(nextArchiveEpoch(epochs.at(-1) ?? 10, discontinuity)); return epochs;
    }, [] as number[])).toEqual([10, 11, 11]);
  });
  it('bounds the writer manifest instead of retaining a multi-day playlist', () => {
    const args = hlsCaptureArgs('http://localhost/stream', '/archive');
    const size = Number(args[args.indexOf('-hls_list_size') + 1]);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(24);
    expect(args.join(' ')).not.toContain('delete_segments');
  });

  it('anchors source-stalled segments to observed file wall time, not advancing PDT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-stall-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const session = '11111111-1111-4111-8111-111111111111';
    const dir = path.join(root, 'archive', 'c', session); fs.mkdirSync(dir, { recursive: true });
    const wall = Date.now() - 3600_000;
    try {
      for (let i = 0; i < 2; i++) {
        const file = path.join(dir, `chunk-${String(i).padStart(9, '0')}.ts`);
        fs.writeFileSync(file, 'complete');
        const end = new Date(wall + (i ? 3600_000 : 20_000));
        fs.utimesSync(file, end, end);
      }
      fs.writeFileSync(path.join(dir, 'current.m3u8'), `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${new Date(wall).toISOString()}\n#EXTINF:20,\nchunk-000000000.ts\n#EXT-X-PROGRAM-DATE-TIME:${new Date(wall + 20_000).toISOString()}\n#EXTINF:20,\nchunk-000000001.ts\n`);
      new ArchiveCapture(store, root, 1).recover();
      const rows = store.overlap('c', 0, Date.now() + 1000);
      expect(rows).toHaveLength(2);
      expect(rows[1].start - rows[0].end).toBeGreaterThan(3_000_000);
      expect(rows[1].epoch).toBeGreaterThan(rows[0].epoch);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers a valid committed TS omitted by a rolled-over manifest without reviving an unlisted newest file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rollover-'));
    let db = new Database(path.join(root, 'archive.sqlite')); ensureArchiveSchema(db);
    let store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const dir = path.join(root, 'archive', 'c', '11111111-1111-4111-8111-111111111111'); fs.mkdirSync(dir, { recursive: true });
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=5', '-t', '2', '-c:v', 'mpeg2video', '-f', 'mpegts', path.join(dir, 'chunk-000000000.ts')]);
      fs.copyFileSync(path.join(dir, 'chunk-000000000.ts'), path.join(dir, 'chunk-000000001.ts'));
      fs.copyFileSync(path.join(dir, 'chunk-000000000.ts'), path.join(dir, 'chunk-000000002.ts'));
      fs.writeFileSync(path.join(dir, 'current.m3u8'), `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nchunk-000000001.ts\n`);
      new ArchiveCapture(store, root, 1).recover();
      expect(store.getChunk('11111111-1111-4111-8111-111111111111-chunk-000000000.ts')).toBeDefined();
      expect(store.getChunk('11111111-1111-4111-8111-111111111111-chunk-000000001.ts')).toBeDefined();
      expect(store.getChunk('11111111-1111-4111-8111-111111111111-chunk-000000002.ts')).toBeUndefined();
      db.close(); db = new Database(path.join(root, 'archive.sqlite')); ensureArchiveSchema(db);
      store = createArchiveStore(db);
      expect(store.cursor('11111111-1111-4111-8111-111111111111')?.sequence).toBe(1);
      new ArchiveCapture(store, root, 1).recover();
      expect(store.overlap('c', 0, Date.now() + 1000)).toHaveLength(2);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it('terminates a silent archive writer once and forces it closed if SIGINT hangs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-silent-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    vi.useFakeTimers();
    try {
      const capture = new ArchiveCapture(store, root, 3001);
      const kill = vi.fn(() => true);
      const writer = { process: { kill }, directory: root, epoch: Date.now(),
        lastPublishedAt: Date.now() - 119_000, timer: setInterval(() => {}, 1_000_000) };
      const internals = capture as unknown as { writers: Map<string, typeof writer>; poll: (id: string) => void };
      internals.writers.set('c', writer);
      internals.poll('c');
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      internals.poll('c');
      internals.poll('c');
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith('SIGINT');
      expect(store.getArchive('c')?.status).toBe('retrying');
      vi.advanceTimersByTime(5_000);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenLastCalledWith('SIGKILL');
      clearInterval(writer.timer);
    } finally { vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('counts newly published segments as writer progress before checking for a stall', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-progress-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const dir = path.join(root, 'archive', 'c', '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'chunk-000000000.ts';
    fs.writeFileSync(path.join(dir, name), 'complete');
    fs.writeFileSync(path.join(dir, 'current.m3u8'), `#EXTM3U\n#EXTINF:20,\n${name}\n`);
    try {
      const capture = new ArchiveCapture(store, root, 3001);
      const kill = vi.fn(() => true);
      const writer = { process: { kill }, directory: dir, epoch: Date.now(),
        lastPublishedAt: Date.now() - 130_000, timer: setInterval(() => {}, 1_000_000) };
      const internals = capture as unknown as { writers: Map<string, typeof writer>; poll: (id: string) => void };
      internals.writers.set('c', writer);
      internals.poll('c');
      expect(store.overlap('c', 0, Date.now() + 1_000)).toHaveLength(1);
      expect(kill).not.toHaveBeenCalled();
      expect(writer.lastPublishedAt).toBeGreaterThan(Date.now() - 2_000);
      clearInterval(writer.timer);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('restarts a stuck FFmpeg child after forced close and the bounded retry delay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-retry-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    vi.useFakeTimers();
    const pinnedFile = path.join(root, 'archive', 'c', 'prior', 'chunk-000000000.ts');
    fs.mkdirSync(path.dirname(pinnedFile), { recursive: true });
    fs.writeFileSync(pinnedFile, 'saved media');
    store.publish({ id: 'prior-chunk-000000000.ts', channelId: 'c', start: Date.now() - 20_000,
      end: Date.now(), duration: 20, path: path.relative(root, pinnedFile), size: 11, epoch: 1 });
    const snapshot = store.createSnapshot('c', Date.now() - 20_000, Date.now(), Date.now(), Date.now() + 3_600_000);
    const child = () => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
    const first = child(), second = child();
    const spawnWriter = vi.fn().mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    try {
      const capture = new ArchiveCapture(store, root, 3001, undefined,
        spawnWriter as unknown as typeof import('node:child_process').spawn);
      capture.start('c');
      expect(spawnWriter).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(120_000);
      expect(first.kill).toHaveBeenCalledWith('SIGINT');
      vi.advanceTimersByTime(5_000);
      expect(first.kill).toHaveBeenCalledWith('SIGKILL');
      first.emit('close', null, 'SIGKILL');
      expect(store.getArchive('c')).toMatchObject({ status: 'retrying', autoRestartCount: 1,
        stalledRestartCount: 1, lastAutoRestartReason: 'stalled', lastRecoveredRestartCount: 0 });
      vi.advanceTimersByTime(9_999);
      expect(spawnWriter).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(spawnWriter).toHaveBeenCalledTimes(2);
      expect(store.getArchive('c')?.lastRecoveredRestartCount).toBe(0);
      const active = (capture as unknown as { writers: Map<string, { directory: string }> }).writers.get('c')!;
      const chunkName = 'chunk-000000000.ts';
      fs.writeFileSync(path.join(active.directory, chunkName), 'new writer media');
      fs.writeFileSync(path.join(active.directory, 'current.m3u8'), `#EXTM3U\n#EXTINF:20,\n${chunkName}\n`);
      vi.advanceTimersByTime(2_000);
      expect(store.getArchive('c')).toMatchObject({ status: 'capturing',
        lastRecoveredRestartCount: 1, lastRecoveredAt: expect.any(Number) });
      expect(store.snapshot(snapshot.id)?.chunks).toHaveLength(1);
      expect(fs.existsSync(pinnedFile)).toBe(true);
      const stopped = capture.stopAll();
      second.emit('close', null, 'SIGINT');
      await stopped;
      expect(store.getArchive('c')?.autoRestartCount).toBe(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a capacity outage in storage_low with a slower retry after child exit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-capacity-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const prior = process.env.STREAMVAULT_ARCHIVE_RESERVE_GB;
    delete process.env.STREAMVAULT_ARCHIVE_RESERVE_GB;
    vi.useFakeTimers();
    const first = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
    const spawnWriter = vi.fn(() => first as unknown as ChildProcess);
    try {
      const capture = new ArchiveCapture(store, root, 3001, undefined,
        spawnWriter as unknown as typeof import('node:child_process').spawn);
      capture.start('c');
      process.env.STREAMVAULT_ARCHIVE_RESERVE_GB = '10000';
      vi.advanceTimersByTime(2_000);
      expect(first.kill).toHaveBeenCalledWith('SIGINT');
      first.emit('close', null, 'SIGINT');
      expect(store.getArchive('c')).toMatchObject({ status: 'storage_low', autoRestartCount: 1,
        stalledRestartCount: 0, lastAutoRestartReason: 'storage_low' });
      vi.advanceTimersByTime(10_000);
      expect(spawnWriter).toHaveBeenCalledTimes(1);
      await capture.stopAll();
      expect((capture as unknown as { retry: Map<string, unknown> }).retry.size).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(spawnWriter).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env.STREAMVAULT_ARCHIVE_RESERVE_GB;
      else process.env.STREAMVAULT_ARCHIVE_RESERVE_GB = prior;
      vi.clearAllTimers(); vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count or retry a writer intentionally stopped while the archive row is enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-manual-stop-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
    const spawnWriter = vi.fn(() => child as unknown as ChildProcess);
    try {
      const capture = new ArchiveCapture(store, root, 3001, undefined,
        spawnWriter as unknown as typeof import('node:child_process').spawn);
      capture.start('c');
      const stopped = capture.stop('c');
      child.emit('close', null, 'SIGINT');
      await stopped;
      vi.advanceTimersByTime(60_000);
      expect(store.getArchive('c')).toMatchObject({ status: 'stopped', autoRestartCount: 0,
        stalledRestartCount: 0 });
      expect(spawnWriter).toHaveBeenCalledTimes(1);
      expect((capture as unknown as { retry: Map<string, unknown> }).retry.size).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('never stores a credential-bearing FFmpeg diagnostic on source exit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-safe-error-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
    const spawnWriter = vi.fn(() => child as unknown as ChildProcess);
    try {
      const capture = new ArchiveCapture(store, root, 3001, undefined,
        spawnWriter as unknown as typeof import('node:child_process').spawn);
      capture.start('c');
      child.stderr.emit('data', Buffer.from('https://user:synthetic-secret@provider.example/stream?token=synthetic-secret'));
      child.emit('close', 1, null);
      expect(store.getArchive('c')).toMatchObject({ status: 'retrying', error: 'Source disconnected' });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('aborts an in-flight seam check before shutdown can close the database', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('live_44115', 'TV4', false, 24);
    const id = '55555555-5555-4555-8555-555555555555-chunk-000000000.ts';
    store.publish({ id, channelId: 'live_44115', start: Date.now() - 20_000, end: Date.now(),
      duration: 20, path: 'unused.ts', size: 188, epoch: 1 });
    let cancelled = false;
    const seamProcessor: typeof import('./archive-seam.js').processArchiveSeam = async (
      _store, _root, _id, _now, _reserve, _maximum, signal,
    ) => new Promise<boolean>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
    });
    vi.useFakeTimers();
    const capture = new ArchiveCapture(store, 'unused', 1, undefined, undefined, seamProcessor);
    try {
      capture.startAll();
      vi.advanceTimersByTime(0);
      await capture.stopAll();
      expect(cancelled).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
  });

  it('runs one nonblocking TV4 seam check at a time and prioritizes fresh capture over backfill', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('live_44115', 'TV4', false, 24);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'].map(s => `${s}-chunk-000000000.ts`);
    vi.useFakeTimers();
    const now = Date.now();
    for (const [i, id] of ids.entries()) {
      store.publish({ id, channelId: 'live_44115', start: now + i * 20_000,
        end: now + (i + 1) * 20_000, duration: 20, path: `${i}.ts`, size: 188, epoch: i });
    }
    const resolves: Array<(result: boolean) => void> = [];
    vi.stubEnv('STREAMVAULT_ARCHIVE_RESERVE_GB', '5');
    vi.stubEnv('STREAMVAULT_ARCHIVE_MAX_DISK_GB', '40');
    const seamProcessor = vi.fn(() => new Promise<boolean>(resolve => { resolves.push(resolve); }));
    const capture = new ArchiveCapture(store, 'unused', 1, undefined, undefined,
      seamProcessor as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    try {
      capture.startAll();
      vi.advanceTimersByTime(0);
      expect(seamProcessor).toHaveBeenCalledTimes(1);
      expect(seamProcessor.mock.calls[0][2]).toBe(ids[2]);
      expect(seamProcessor.mock.calls[0].slice(4, 6)).toEqual([5 * 1024 ** 3, 40 * 1024 ** 3]);
      const freshId = '44444444-4444-4444-8444-444444444444-chunk-000000000.ts';
      (capture as unknown as { enqueueSeam: (id: string, urgent: boolean) => void }).enqueueSeam(freshId, true);
      expect(seamProcessor).toHaveBeenCalledTimes(1);
      resolves[0](false);
      await vi.waitFor(() => expect(resolves).toHaveLength(1));
      await Promise.resolve(); await Promise.resolve();
      vi.advanceTimersByTime(3_000);
      expect(seamProcessor.mock.calls[1][2]).toBe(freshId);
      resolves[1](false);
      await Promise.resolve(); await Promise.resolve();
      vi.advanceTimersByTime(9_999);
      expect(seamProcessor).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(seamProcessor).toHaveBeenCalledTimes(3); // paced historical backfill
      resolves[2](false);
      await capture.stopAll();
      vi.advanceTimersByTime(60_000);
      expect(seamProcessor).toHaveBeenCalledTimes(3);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); db.close(); }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { parsePublishedSegments, hlsCaptureArgs, hasArchiveReserve, hasArchiveCapacity, nextArchiveEpoch, archiveRetryDelay } from './archive-capture.js';
import { ArchiveCapture } from './archive-capture.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
  it('removes crash-orphaned pair presentations but retains both committed pair files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-restart-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const priorSession = '11111111-1111-4111-8111-111111111111';
    const nextSession = '22222222-2222-4222-8222-222222222222';
    const token = '33333333-3333-4333-8333-333333333333';
    const priorId = `${priorSession}-chunk-000000006.ts`;
    const nextId = `${nextSession}-chunk-000000000.ts`;
    const raw = (session: string, name: string) => path.join('archive', 'c', session, name);
    const priorRaw = raw(priorSession, 'chunk-000000006.ts');
    const nextRaw = raw(nextSession, 'chunk-000000000.ts');
    const priorPair = raw(priorSession, `chunk-000000006.${token}.pair.playback.ts`);
    const nextPair = raw(nextSession, `chunk-000000000.${token}.pair.playback.ts`);
    const orphan = raw(nextSession, `chunk-000000000.44444444-4444-4444-8444-444444444444.pair.playback.ts`);
    try {
      for (const relative of [priorRaw, nextRaw, priorPair, nextPair, orphan]) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), Buffer.alloc(188, 0x47));
      }
      store.publish({ id: priorId, channelId: 'c', start: 100_000, end: 120_000,
        duration: 20, path: priorRaw, size: 188, epoch: 1 });
      store.publish({ id: nextId, channelId: 'c', start: 108_000, end: 128_000,
        duration: 20, path: nextRaw, size: 188, epoch: 2 });
      expect(store.publishPlaybackPair({ priorId, nextId, priorRawPath: priorRaw, nextRawPath: nextRaw,
        priorPath: priorPair, priorSize: 188, priorCut: 14,
        nextPath: nextPair, nextSize: 188, nextOffset: 6, nextDuration: 14 })).toBe(true);
      new ArchiveCapture(store, root, 1).recover();
      expect(fs.existsSync(path.join(root, priorPair))).toBe(true);
      expect(fs.existsSync(path.join(root, nextPair))).toBe(true);
      expect(fs.existsSync(path.join(root, orphan))).toBe(false);
      const now = Date.now();
      const pinned = store.createSnapshot('c', 100_000, 130_000, now, now + 60_000, true);
      fs.unlinkSync(path.join(root, nextPair));
      new ArchiveCapture(store, root, 1).recover();
      expect(store.getChunk(priorId)?.pairId).toBeNull();
      expect(store.getChunk(nextId)?.pairId).toBeNull();
      expect(store.snapshot(pinned.id)).toBeUndefined();
      expect(fs.existsSync(path.join(root, priorPair))).toBe(true);
      expect(store.detachedPlayback()).toEqual([]);
      expect(store.totalUsageBytes()).toBe(4 * 188);
      const rawTicket = store.createSnapshot('c', 100_000, 130_000, now, now + 60_000, true);
      expect(rawTicket.chunks.every(chunk => !chunk.playbackPath)).toBe(true);
      store.clearExpired(now + 60_000);
      new ArchiveCapture(store, root, 1).recover();
      expect(fs.existsSync(path.join(root, priorPair))).toBe(false);
      expect(store.totalUsageBytes()).toBe(2 * 188);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('quarantines an unpinned pair with a missing raw master without breaking startup or quota', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-raw-missing-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const sessions = ['11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'];
    const ids = sessions.map((session, index) => `${session}-chunk-${index ? '000000000' : '000000006'}.ts`);
    const raw = sessions.map((session, index) => path.join('archive', 'c', session,
      `chunk-${index ? '000000000' : '000000006'}.ts`));
    const copies = raw.map(file => file.replace(/\.ts$/, '.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pair.playback.ts'));
    try {
      for (const file of [...raw, ...copies]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), Buffer.alloc(188, 0x47));
      }
      store.publish({ id: ids[0], channelId: 'c', start: 100_000, end: 120_000,
        duration: 20, path: raw[0], size: 188, epoch: 1 });
      store.publish({ id: ids[1], channelId: 'c', start: 108_000, end: 128_000,
        duration: 20, path: raw[1], size: 188, epoch: 2 });
      expect(store.publishPlaybackPair({ priorId: ids[0], nextId: ids[1], priorRawPath: raw[0],
        nextRawPath: raw[1], priorPath: copies[0], priorSize: 188, priorCut: 14,
        nextPath: copies[1], nextSize: 188, nextOffset: 6, nextDuration: 14 })).toBe(true);
      fs.unlinkSync(path.join(root, raw[0]));
      expect(() => new ArchiveCapture(store, root, 1).recover()).not.toThrow();
      expect(store.getChunk(ids[0])?.unavailable).toBe(1);
      expect(store.getChunk(ids[0])?.pairId).toBeTruthy();
      expect(store.totalUsageBytes()).toBe(3 * 188);
      expect(store.overlap('c', 100_000, 128_000, true)).toEqual([]);
      fs.writeFileSync(path.join(root, raw[0]), Buffer.alloc(188, 0x47));
      new ArchiveCapture(store, root, 1).recover();
      expect(store.getChunk(ids[0])?.unavailable).toBe(0);
      expect(store.totalUsageBytes()).toBe(4 * 188);
      expect(store.createSnapshot('c', 100_000, 128_000, Date.now(), Date.now() + 60000, true)
        .chunks.every(chunk => !!chunk.playbackPath)).toBe(true);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('restores a broken upstream pair and its dependent downstream pair as one raw chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-chain-restart-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('c', 'C', true, 24);
    const sessions = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const ids = [
      `${sessions[0]}-chunk-000000006.ts`, `${sessions[1]}-chunk-000000000.ts`,
      `${sessions[1]}-chunk-000000001.ts`, `${sessions[2]}-chunk-000000000.ts`,
    ];
    const relative = (id: string, derivative = false) => path.join('archive', 'c',
      id.split('-chunk-')[0], `chunk-${id.split('-chunk-')[1].replace(/\.ts$/, '')}${derivative ? '.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pair.playback' : ''}.ts`);
    const raw = ids.map(id => relative(id));
    const copy = ids.map(id => relative(id, true));
    try {
      for (const file of [...raw, ...copy]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), Buffer.alloc(188, 0x47));
      }
      for (const [index, start, end, epoch] of [
        [0, 100_000, 120_000, 1], [1, 108_000, 128_000, 2],
        [2, 133_000, 153_000, 2], [3, 145_000, 165_000, 3],
      ] as const) store.publish({ id: ids[index], channelId: 'c', start, end,
        duration: 20, path: raw[index], size: 188, epoch });
      expect(store.publishPlaybackPair({ priorId: ids[0], nextId: ids[1],
        priorRawPath: raw[0], nextRawPath: raw[1], priorPath: copy[0], priorSize: 188, priorCut: 14,
        nextPath: copy[1], nextSize: 188, nextOffset: 6, nextDuration: 14,
        sessionTimeline: [{ id: ids[1], presentationStart: 114_000 },
          { id: ids[2], presentationStart: 128_000 }] })).toBe(true);
      expect(store.publishPlaybackPair({ priorId: ids[2], nextId: ids[3],
        priorRawPath: raw[2], nextRawPath: raw[3], priorPath: copy[2], priorSize: 188, priorCut: 14,
        nextPath: copy[3], nextSize: 188, nextOffset: 6, nextDuration: 14 })).toBe(true);
      fs.unlinkSync(path.join(root, copy[0]));
      new ArchiveCapture(store, root, 1).recover();
      expect(ids.map(id => store.getChunk(id)?.pairId)).toEqual([null, null, null, null]);
      expect(ids.map(id => store.getChunk(id)?.path)).toEqual(raw);
      expect(store.detachedPlayback()).toEqual([]);
      expect(store.totalUsageBytes()).toBe(4 * 188);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('sends the capture session tag alongside authentication on a real FFmpeg HTTP request', async () => {
    const session = '11111111-1111-4111-8111-111111111111';
    let observed: { session?: string; auth?: string } = {};
    const server = createServer((req, res) => {
      observed = { session: req.headers['x-streamvault-capture-session'] as string | undefined,
        auth: req.headers.authorization };
      res.writeHead(404); res.end();
    });
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'archive-http-tag-'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const proc = spawn('ffmpeg', hlsCaptureArgs(`http://127.0.0.1:${port}/stream`, root,
        'synthetic-test-token', session), { stdio: ['ignore', 'ignore', 'ignore'] });
      await Promise.race([new Promise<void>(resolve => proc.once('close', () => resolve())),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ffmpeg request timeout')), 5_000))]);
      expect(observed).toEqual({ session, auth: 'Bearer synthetic-test-token' });
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    const tagged = hlsCaptureArgs('http://127.0.0.1:3001/api/stream/one', '/archive', undefined,
      '11111111-1111-4111-8111-111111111111');
    expect(tagged[tagged.indexOf('-headers') + 1]).toBe('X-StreamVault-Capture-Session: 11111111-1111-4111-8111-111111111111\r\n');
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

  it('keeps normal and storage backoff unless a canary writer had a fresh clean exit', () => {
    const eligible = { channelId: 'live_44115', allowlist: 'live_44115', code: 0, signal: null,
      sessionMs: 45_000, publishAgeMs: 5_000, proxyEndAgeMs: 500, hasPublished: true,
      fastAttemptsLast10Min: 0, stalled: false, storageLow: false };
    expect(archiveRetryDelay(eligible)).toBe(1_000);
    for (const override of [
      { allowlist: '' }, { channelId: 'live_17289' }, { code: 1 }, { signal: 'SIGINT' },
      { sessionMs: 29_999 }, { publishAgeMs: 30_001 }, { proxyEndAgeMs: -1 },
      { proxyEndAgeMs: 5_001 }, { hasPublished: false }, { stalled: true },
      { fastAttemptsLast10Min: 4 },
    ]) expect(archiveRetryDelay({ ...eligible, ...override })).toBe(10_000);
    expect(archiveRetryDelay({ ...eligible, proxyEndAgeMs: undefined })).toBe(10_000);
    expect(archiveRetryDelay({ ...eligible, storageLow: true })).toBe(60_000);
  });

  it('retries a published TV4 EOF promptly while preserving a new repairable session', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'archive-eof-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('live_44115', 'TV4', true, 24);
    const previous = process.env.STREAMVAULT_FAST_EOF_CHANNEL_IDS;
    process.env.STREAMVAULT_FAST_EOF_CHANNEL_IDS = 'live_44115';
    vi.useFakeTimers();
    const child = () => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
    const first = child(), second = child(), third = child();
    const spawnWriter = vi.fn().mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess)
      .mockReturnValueOnce(third as unknown as ChildProcess);
    try {
      const capture = new ArchiveCapture(store, root, 3001, undefined,
        spawnWriter as unknown as typeof import('node:child_process').spawn);
      capture.start('live_44115');
      vi.advanceTimersByTime(30_000);
      const directory = (capture as unknown as { writers: Map<string, { directory: string }> }).writers.get('live_44115')!.directory;
      fs.writeFileSync(path.join(directory, 'chunk-000000000.ts'), 'first media');
      fs.writeFileSync(path.join(directory, 'current.m3u8'), '#EXTM3U\n#EXTINF:20,\nchunk-000000000.ts\n');
      vi.advanceTimersByTime(2_000);
      expect(store.cursor(path.basename(directory))).toBeDefined();
      const pinned = store.createSnapshot('live_44115', Date.now() - 40_000, Date.now(), Date.now(), Date.now() + 60_000);
      capture.noteProxyLifecycle('live_44115', '00000000-0000-4000-8000-000000000000', 'upstream_end', true);
      capture.noteProxyLifecycle('live_44115', path.basename(directory), 'client_close', false);
      const observed = (capture as unknown as { writers: Map<string, { proxyEndAt?: number }> }).writers.get('live_44115')!;
      expect(observed.proxyEndAt).toBeUndefined();
      capture.noteProxyLifecycle('live_44115', path.basename(directory), 'upstream_end', true);
      expect(observed.proxyEndAt).toBe(Date.now());
      first.emit('close', 0, null);
      expect(store.getArchive('live_44115')).toMatchObject({ autoRestartCount: 1, lastRecoveredRestartCount: 0 });
      vi.advanceTimersByTime(999);
      expect(spawnWriter).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(spawnWriter).toHaveBeenCalledTimes(2);
      const replacement = (capture as unknown as { writers: Map<string, { directory: string }> }).writers.get('live_44115')!.directory;
      expect(replacement).not.toBe(directory);
      expect(store.getArchive('live_44115')?.lastRecoveredRestartCount).toBe(0);
      fs.writeFileSync(path.join(replacement, 'chunk-000000000.ts'), 'new writer media');
      fs.writeFileSync(path.join(replacement, 'current.m3u8'), '#EXTM3U\n#EXTINF:20,\nchunk-000000000.ts\n');
      vi.advanceTimersByTime(2_000);
      expect(store.cursor(path.basename(replacement))).toBeDefined();
      expect(store.getArchive('live_44115')).toMatchObject({ status: 'capturing', lastRecoveredRestartCount: 1 });
      expect(store.snapshot(pinned.id)?.chunks.map(chunk => chunk.id)).toEqual([`${path.basename(directory)}-chunk-000000000.ts`]);
      expect(fs.existsSync(path.join(directory, 'chunk-000000000.ts'))).toBe(true);
      vi.advanceTimersByTime(28_000);
      const history = (capture as unknown as { fastRetryHistory: Map<string, number[]> }).fastRetryHistory;
      history.set('live_44115', [0, 1, 2, 3].map(i => Date.now() - i * 1_000));
      capture.noteProxyLifecycle('live_44115', path.basename(replacement), 'upstream_end', true);
      second.emit('close', 0, null);
      vi.advanceTimersByTime(9_999);
      expect(spawnWriter).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(spawnWriter).toHaveBeenCalledTimes(3);
      expect(history.get('live_44115')).toHaveLength(4);
      const stopped = capture.stopAll(); third.emit('close', null, 'SIGINT'); await stopped;
    } finally {
      if (previous === undefined) delete process.env.STREAMVAULT_FAST_EOF_CHANNEL_IDS;
      else process.env.STREAMVAULT_FAST_EOF_CHANNEL_IDS = previous;
      vi.clearAllTimers(); vi.useRealTimers(); db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
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
    const store = createArchiveStore(db); store.configure('live_44115', 'TV4', true, 24);
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-abort-seam-'));
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined, seamProcessor);
    try {
      (capture as unknown as { enqueueSeam: (id: string, urgent: boolean) => void }).enqueueSeam(id, true);
      vi.advanceTimersByTime(0);
      await capture.stopAll();
      expect(cancelled).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close();
      fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('awaits and aborts an in-flight repair on archive disable', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const id = '11111111-1111-4111-8111-111111111111-chunk-000000000.ts';
    store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-disable-work-'));
    let cancelled = false;
    const processor: typeof import('./archive-seam.js').processArchiveSeam = async (
      _store, _root, _id, _now, _reserve, _max, signal,
    ) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
    });
    vi.useFakeTimers();
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined, processor);
    try {
      (capture as unknown as { enqueueSeam: (id: string, urgent: boolean) => void }).enqueueSeam(id, true);
      vi.advanceTimersByTime(0);
      await capture.stopArchive('espn');
      expect(cancelled).toBe(true);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close();
      fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels queued repairs when an archive is disabled', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const id = '11111111-1111-4111-8111-111111111111-chunk-000000000.ts';
    store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-disable-repair-'));
    const processSeam = vi.fn(async () => false);
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined,
      processSeam as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    vi.useFakeTimers();
    try {
      const internals = capture as unknown as { seamQueue: string[];
        enqueueSeam: (id: string, urgent: boolean) => void };
      internals.enqueueSeam(id, true);
      await capture.stopArchive('espn');
      store.configure('espn', 'ESPN', false, 24);
      vi.advanceTimersByTime(60_000);
      expect(processSeam).not.toHaveBeenCalled();
      expect(internals.seamQueue).toEqual([]);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close();
      fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('does not enqueue or run seam repairs during raw playback fallback', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const id = 'fresh-chunk-000000000.ts';
    store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-raw-queue-'));
    const processSeam = vi.fn(async () => false);
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined,
      processSeam as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    vi.useFakeTimers(); vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    try {
      const internals = capture as unknown as { seamQueue: string[];
        enqueueSeam: (id: string, urgent: boolean) => void };
      internals.enqueueSeam(id, true);
      capture.prioritizeWindow('espn', 0, 20_000);
      vi.advanceTimersByTime(60_000);
      expect(internals.seamQueue).toEqual([]);
      expect(processSeam).not.toHaveBeenCalled();
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('serializes an explicitly allowlisted pair job while keeping legacy seam jobs disabled in raw mode', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const id = 'fresh-chunk-000000000.ts';
    store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-queue-'));
    const processSeam = vi.fn(async () => false);
    const processPair = vi.fn(async () => false);
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined,
      processSeam as unknown as typeof import('./archive-seam.js').processArchiveSeam,
      processPair as unknown as typeof import('./archive-pair-worker.js').processArchivePair);
    vi.useFakeTimers(); vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', 'espn');
    try {
      const internals = capture as unknown as { seamQueue: string[];
        enqueueSeam: (id: string, urgent: boolean) => void };
      internals.enqueueSeam(id, true);
      expect(internals.seamQueue).toEqual([id]);
      await vi.advanceTimersByTimeAsync(0);
      expect(processPair).toHaveBeenCalledTimes(1);
      expect(processSeam).not.toHaveBeenCalled();
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('requeues the previous completed session when the next session first chunk closes it', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-handoff-'));
    const older = '11111111-1111-4111-8111-111111111111';
    const newer = '22222222-2222-4222-8222-222222222222';
    const first = `${older}-chunk-000000000.ts`;
    const tail = `${older}-chunk-000000001.ts`;
    const now = Date.now();
    store.publish({ id: first, channelId: 'one', start: now - 60_000,
      end: now - 40_000, duration: 20, path: 'first.ts', size: 188, epoch: 1 });
    store.publish({ id: tail, channelId: 'one', start: now - 40_000,
      end: now - 20_000, duration: 20, path: 'tail.ts', size: 188, epoch: 1 });
    const dir = path.join(root, 'archive', 'one', newer);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'chunk-000000000.ts'), Buffer.alloc(188, 0x47));
    const capture = new ArchiveCapture(store, root, 1);
    vi.useFakeTimers({ now }); vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', 'one');
    try {
      (capture as unknown as { publishFile: (channelId: string, directory: string,
        name: string, duration: number, discontinuity: boolean) => void })
        .publishFile('one', dir, 'chunk-000000000.ts', 20, false);
      const queued = (capture as unknown as { seamQueue: string[] }).seamQueue;
      expect(queued).toContain(first);
      expect(queued).toContain(`${newer}-chunk-000000000.ts`);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('drops queued repair work when raw fallback activates before dispatch', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const id = 'fresh-chunk-000000000.ts';
    store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-queued-raw-'));
    const processSeam = vi.fn(async () => false);
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined,
      processSeam as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    vi.useFakeTimers();
    try {
      const internals = capture as unknown as { seamQueue: string[];
        enqueueSeam: (id: string, urgent: boolean) => void };
      internals.enqueueSeam(id, true);
      expect(internals.seamQueue).toEqual([id]);
      vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
      vi.advanceTimersByTime(60_000);
      expect(internals.seamQueue).toEqual([]);
      expect(processSeam).not.toHaveBeenCalled();
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('pauses derivative repair before it crowds the capture disk cap, then resumes', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-repair-headroom-'));
    const processSeam = vi.fn(async () => false);
    const capture = new ArchiveCapture(store, root, 1, undefined, undefined,
      processSeam as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    vi.useFakeTimers(); vi.stubEnv('STREAMVAULT_ARCHIVE_MAX_DISK_GB', '1');
    vi.stubEnv('STREAMVAULT_ARCHIVE_RESERVE_GB', '1');
    const usage = vi.spyOn(store, 'totalUsageBytes').mockReturnValueOnce(980 * 1024 ** 2).mockReturnValue(0);
    try {
      const id = 'fresh-chunk-000000000.ts';
      store.publish({ id, channelId: 'espn', start: 0, end: 20_000,
        duration: 20, path: 'raw.ts', size: 188, epoch: 1 });
      const internals = capture as unknown as { seamQueue: string[];
        enqueueSeam: (id: string, urgent: boolean) => void };
      internals.enqueueSeam(id, true);
      vi.advanceTimersByTime(0);
      expect(processSeam).not.toHaveBeenCalled();
      expect(internals.seamQueue).toContain(id);
      vi.advanceTimersByTime(60_000);
      expect(processSeam).toHaveBeenCalledTimes(1);
      await capture.stopAll();
    } finally { usage.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('queues a historical single-file derivative for pair repair only after its last pin expires', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pair-backfill-'));
    const prior = '11111111-1111-4111-8111-111111111111-chunk-000000006.ts';
    const next = '22222222-2222-4222-8222-222222222222-chunk-000000000.ts';
    store.publish({ id: prior, channelId: 'espn', start: 0, end: 20_000,
      duration: 20, path: 'prior.ts', size: 188, epoch: 1 });
    store.publish({ id: next, channelId: 'espn', start: 15_000, end: 35_000,
      duration: 20, path: 'next.ts', size: 188, epoch: 2 });
    expect(store.setPlaybackMedia(next, 'old.playback.ts', 188, 5, 15, Date.now())).toBe(true);
    const now = Date.now();
    store.createSnapshot('espn', 0, 40_000, now, now + 500, false);
    const capture = new ArchiveCapture(store, root, 1);
    vi.useFakeTimers(); vi.stubEnv('STREAMVAULT_ARCHIVE_RAW_PLAYBACK', '1');
    vi.stubEnv('STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS', 'espn');
    try {
      const internals = capture as unknown as { seamQueue: string[] };
      capture.prioritizeWindow('espn', 0, 40_000);
      expect(internals.seamQueue).not.toContain(next);
      store.clearExpired(now + 501);
      capture.prioritizeWindow('espn', 0, 40_000);
      expect(internals.seamQueue).toContain(next);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
      db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('promotes a queued historical seam when a viewer requests that window', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
    const capture = new ArchiveCapture(store, 'unused', 1);
    vi.useFakeTimers();
    try {
      const internals = capture as unknown as { seamQueue: string[]; seamQueued: Set<string>;
        prioritizeWindow: (channelId: string, start: number, end: number) => void };
      const ids = [0, 1, 2].map(i => `${i}-chunk-000000000.ts`);
      ids.forEach((id, i) => store.publish({ id, channelId: 'espn', start: i * 20_000,
        end: (i + 1) * 20_000, duration: 20, path: `${i}.ts`, size: 188, epoch: i }));
      internals.seamQueue.push(...ids); ids.forEach(id => internals.seamQueued.add(id));
      internals.prioritizeWindow('espn', 20_000, 40_000);
      expect(internals.seamQueue).toEqual([ids[1], ids[0], ids[2]]);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
  });

  it('keeps an urgent reconnect when the historical queue is full', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db);
    const capture = new ArchiveCapture(store, 'unused', 1);
    vi.useFakeTimers();
    try {
      const internals = capture as unknown as { seamQueue: string[]; seamQueued: Set<string>;
        enqueueSeam: (id: string, urgent: boolean) => void };
      const old = Array.from({ length: 20_000 }, (_, i) => `${i}-chunk-000000000.ts`);
      internals.seamQueue.push(...old); old.forEach(id => internals.seamQueued.add(id));
      const fresh = 'fresh-chunk-000000000.ts';
      internals.enqueueSeam(fresh, true);
      expect(internals.seamQueue[0]).toBe(fresh);
      expect(internals.seamQueue).toHaveLength(20_000);
      await capture.stopAll();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
  });

  it('runs one nonblocking TV4 seam check at a time and prioritizes fresh capture over backfill', async () => {
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    const store = createArchiveStore(db); store.configure('live_44115', 'TV4', true, 24);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'].map(s => `${s}-chunk-000000000.ts`);
    vi.useFakeTimers();
    const now = Date.now();
    const espnId = '55555555-5555-4555-8555-555555555555-chunk-000000000.ts';
    store.configure('live_1015944', 'ESPN', true, 24);
    store.publish({ id: espnId, channelId: 'live_1015944', start: now + 60_000,
      end: now + 80_000, duration: 20, path: 'espn.ts', size: 188, epoch: 4 });
    const disabledId = '66666666-6666-4666-8666-666666666666-chunk-000000000.ts';
    store.configure('disabled', 'Disabled', false, 24);
    store.publish({ id: disabledId, channelId: 'disabled', start: now + 80_000,
      end: now + 100_000, duration: 20, path: 'disabled.ts', size: 188, epoch: 5 });
    for (const [i, id] of ids.entries()) {
      store.publish({ id, channelId: 'live_44115', start: now + i * 20_000,
        end: now + (i + 1) * 20_000, duration: 20, path: `${i}.ts`, size: 188, epoch: i });
    }
    store.createSnapshot('live_44115', now, now + 20_000, Date.now(), Date.now() + 60_000);
    const resolves: Array<(result: boolean) => void> = [];
    vi.stubEnv('STREAMVAULT_ARCHIVE_RESERVE_GB', '5');
    vi.stubEnv('STREAMVAULT_ARCHIVE_MAX_DISK_GB', '40');
    const seamProcessor = vi.fn(() => new Promise<boolean>(resolve => { resolves.push(resolve); }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seam-queue-'));
    const fakeSpawn = vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(),
        kill: () => { queueMicrotask(() => proc.emit('close', 0)); return true; } });
      return proc as unknown as ChildProcess;
    });
    const capture = new ArchiveCapture(store, root, 1, undefined,
      fakeSpawn as unknown as typeof import('node:child_process').spawn,
      seamProcessor as unknown as typeof import('./archive-seam.js').processArchiveSeam);
    try {
      capture.startAll();
      vi.advanceTimersByTime(0);
      expect(seamProcessor).toHaveBeenCalledTimes(1);
      expect(seamProcessor.mock.calls[0][2]).toBe(ids[0]); // currently viewed archive window
      expect(seamProcessor.mock.calls[0].slice(4, 6)).toEqual([5 * 1024 ** 3, 40 * 1024 ** 3]);
      const session = '44444444-4444-4444-8444-444444444444';
      const freshId = `${session}-chunk-000000000.ts`;
      const directory = path.join(root, 'archive', 'live_1015944', session);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'chunk-000000000.ts'), 'media');
      (capture as unknown as { publishFile: (channel: string, dir: string, name: string,
        duration: number, discontinuity: boolean) => void }).publishFile(
        'live_1015944', directory, 'chunk-000000000.ts', 20, false);
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
      expect(seamProcessor.mock.calls[2][2]).toBe(espnId);
      resolves[2](false);
      await capture.stopAll();
      vi.advanceTimersByTime(60_000);
      expect(seamProcessor).toHaveBeenCalledTimes(3);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); db.close();
      fs.rmSync(root, { recursive: true, force: true }); }
  });
});

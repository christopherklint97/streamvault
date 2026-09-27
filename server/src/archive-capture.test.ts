import { describe, it, expect } from 'vitest';
import { parsePublishedSegments, hlsCaptureArgs, hasArchiveReserve, hasArchiveCapacity, nextArchiveEpoch } from './archive-capture.js';
import { ArchiveCapture } from './archive-capture.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
});

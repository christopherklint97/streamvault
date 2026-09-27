import { describe, it, expect } from 'vitest';
import { parsePublishedSegments, hlsCaptureArgs, hasArchiveReserve, hasArchiveCapacity, nextArchiveEpoch } from './archive-capture.js';
import { ArchiveCapture } from './archive-capture.js';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    expect(store.overlap('c', 0, 2_000_000)).toHaveLength(20);
    expect(fs.existsSync(path.join(dir, 'chunk-000000020.ts'))).toBe(false);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  it('only imports completed manifest-listed chunks with source clock, never partial output', () => {
    const playlist = `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:00.000Z\n#EXTINF:19.520,\nchunk-000000001.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:19.520Z\n#EXTINF:20.040,\nchunk-000000002.ts\n`;
    expect(parsePublishedSegments(playlist)).toEqual([
      { name: 'chunk-000000001.ts', start: Date.parse('2026-09-27T12:00:00Z'), duration: 19.52, discontinuity: false },
      { name: 'chunk-000000002.ts', start: Date.parse('2026-09-27T12:00:19.520Z'), duration: 20.04, discontinuity: false },
    ]);
    const args = hlsCaptureArgs('http://127.0.0.1:3001/api/stream/one', '/tmp/archive');
    expect(args).toContain('-c'); expect(args).toContain('copy');
    expect(args.join(' ')).toContain('temp_file');
    expect(args).toContain('0'); // retain every published segment in the restart index
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
});

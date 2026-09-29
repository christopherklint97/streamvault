import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchedPrefix, fullDuplicateInSameWindow, prepareSeamCopy, processArchiveSeam } from './archive-seam.js';
import Database from 'better-sqlite3';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';

const run = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout: 30_000 });

describe('conservative TS seam copy', () => {
  it('accepts a torn final video packet only when a long exact prefix reaches the prior tail', () => {
    const packet = (index: number, value: string) => ({ stream_index: 0,
      pts_time: (index * 0.04).toFixed(3), duration_time: '0.04', flags: '___', data_hash: value });
    const previous = Array.from({ length: 100 }, (_, i) => packet(i, `hash-${i}`));
    const next = [...previous.slice(40, 99).map((p, i) => packet(i, p.data_hash)),
      ...Array.from({ length: 20 }, (_, i) => packet(59 + i, `unique-${i}`))];
    expect(matchedPrefix(previous, next)).toBeCloseTo(59 * 0.04);
    const diverged = [...next]; diverged[12] = packet(12, 'different');
    expect(matchedPrefix(previous, diverged)).toBeUndefined();
  });

  it('rejects a full duplicate whose video and audio match different prior moments', () => {
    const packet = (index: number, kind: string) => ({ stream_index: kind === 'v' ? 0 : 1,
      pts_time: (index * 0.04).toFixed(3), duration_time: '0.04', flags: '___', data_hash: `${kind}-${index}` });
    const video = Array.from({ length: 150 }, (_, i) => packet(i, 'v'));
    const audio = Array.from({ length: 150 }, (_, i) => packet(i, 'a'));
    const recent = (packets: typeof video, first: number) => packets.slice(first, first + 80).map((p, i) =>
      ({ ...p, pts_time: (i * 0.04).toFixed(3) }));
    expect(fullDuplicateInSameWindow([{ video, audio }], { video: recent(video, 10), audio: recent(audio, 50) }))
      .toBe(false);
    expect(fullDuplicateInSameWindow([{ video, audio }], { video: recent(video, 10), audio: recent(audio, 12) }))
      .toBe(true);
  });

  it('preserves unique tail after a verified AAC and H264 prefix overlap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seam-'));
    try {
      const master = path.join(dir, 'master.ts');
      const earlier = path.join(dir, 'earlier.ts');
      const prior = path.join(dir, 'prior.ts');
      const next = path.join(dir, 'next.ts');
      const output = path.join(dir, 'next.playback.ts');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', master]);
      run(['-ss', '0', '-i', master, '-t', '5', '-c', 'copy', '-f', 'mpegts', earlier]);
      run(['-ss', '5', '-i', master, '-t', '2', '-c', 'copy', '-f', 'mpegts', prior]);
      run(['-ss', '3', '-i', master, '-t', '7', '-c', 'copy', '-f', 'mpegts', next]);
      const result = await prepareSeamCopy([earlier, prior], next, output);
      expect(result?.kind).toBe('trim');
      if (result?.kind !== 'trim') throw new Error('expected verified partial trim');
      expect(result.offset).toBeGreaterThan(0.5);
      expect(result.offset).toBeLessThan(4);
      expect(result.duration).toBeGreaterThan(2);
      expect(result.size).toBe(fs.statSync(output).size);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_packets',
        '-show_entries', 'stream=codec_name:packet=stream_index,flags,pts_time', '-of', 'json', output]).toString());
      expect(probe.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(['aac', 'h264']);
      const videoIndex = probe.streams.findIndex((s: { codec_name: string }) => s.codec_name === 'h264');
      expect(probe.packets.find((p: { stream_index: number }) => p.stream_index === videoIndex).flags).toContain('K');
      const db = new Database(':memory:'); ensureArchiveSchema(db);
      const store = createArchiveStore(db); store.configure('live_44115', 'TV4', true, 24);
      const sessionA = '11111111-1111-4111-8111-111111111111';
      const sessionB = '22222222-2222-4222-8222-222222222222';
      for (const [id, file, start, duration] of [
        [`${sessionA}-chunk-000000000.ts`, earlier, 0, 5],
        [`${sessionA}-chunk-000000001.ts`, prior, 5000, 2],
        [`${sessionB}-chunk-000000000.ts`, next, 7000, 7],
      ] as const) store.publish({ id, channelId: 'live_44115', start, end: start + duration * 1000,
        duration, path: path.relative(dir, file), size: fs.statSync(file).size, epoch: 1 });
      fs.unlinkSync(output);
      const target = `${sessionB}-chunk-000000000.ts`;
      const pin = store.createSnapshot('live_44115', 7000, 14_000, 1, 100);
      expect(await processArchiveSeam(store, dir, target, 2, 0,
        store.totalUsageBytes() + Math.ceil(fs.statSync(next).size * 1.5) - 1)).toBe(false);
      expect(store.getChunk(target)?.playbackPath).toBeNull();
      expect(await processArchiveSeam(store, dir, target, 2, 0)).toBe(true);
      expect(store.snapshot(pin.id)?.chunks.at(-1)?.playbackPath).toBeNull();
      const fresh = store.createSnapshot('live_44115', 7000, 14_000, 3, 100);
      expect(store.snapshot(fresh.id)?.chunks.at(-1)?.playbackPath).toBe('next.playback.ts');
      expect(store.getChunk(target)?.playbackPath).toBe('next.playback.ts');
      expect(fs.existsSync(next)).toBe(true);
      expect(store.totalUsageBytes()).toBe(fs.statSync(earlier).size + fs.statSync(prior).size +
        fs.statSync(next).size + fs.statSync(output).size);
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('keeps the master and old pins while omitting a fully duplicated new chunk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-full-seam-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    try {
      const master = path.join(dir, 'master.ts');
      const earlier = path.join(dir, 'earlier.ts');
      const prior = path.join(dir, 'prior.ts');
      const duplicate = path.join(dir, 'duplicate.ts');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=8',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=8',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-c:a', 'aac', '-f', 'mpegts', master]);
      run(['-ss', '0', '-i', master, '-t', '4', '-c', 'copy', '-f', 'mpegts', earlier]);
      run(['-ss', '4', '-i', master, '-t', '4', '-c', 'copy', '-f', 'mpegts', prior]);
      fs.copyFileSync(prior, duplicate);
      const result = await prepareSeamCopy([earlier, prior], duplicate,
        path.join(dir, 'duplicate.playback.ts.part'));
      expect(result).toEqual({ kind: 'duplicate' });
      const store = createArchiveStore(db); store.configure('live_44115', 'TV4', true, 24);
      const first = '11111111-1111-4111-8111-111111111111';
      const last = '22222222-2222-4222-8222-222222222222';
      const ids = [`${first}-chunk-000000000.ts`, `${first}-chunk-000000001.ts`,
        `${last}-chunk-000000000.ts`];
      [earlier, prior, duplicate].forEach((file, i) => store.publish({ id: ids[i], channelId: 'live_44115',
        start: i * 4_000, end: (i + 1) * 4_000, duration: 4, path: path.relative(dir, file),
        size: fs.statSync(file).size, epoch: i < 2 ? 1 : 2 }));
      const pin = store.createSnapshot('live_44115', 0, 12_000, 1, 100);
      expect(await processArchiveSeam(store, dir, ids[2], 2, 0)).toBe(true);
      expect(store.getChunk(ids[2])?.playbackHidden).toBe(1);
      expect(store.snapshot(pin.id)?.chunks.map(c => c.id)).toEqual(ids);
      expect(store.createSnapshot('live_44115', 0, 12_000, 3, 100).chunks.map(c => c.id))
        .toEqual(ids.slice(0, 2));
      expect(fs.existsSync(duplicate)).toBe(true);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('leaves dissimilar media untouched without producing a derivative', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seam-negative-'));
    try {
      const prior = path.join(dir, 'prior.ts');
      const next = path.join(dir, 'next.ts');
      const output = path.join(dir, 'next.playback.ts');
      for (const [file, freq] of [[prior, '440'], [next, '660']]) {
        run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=4',
          '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`, '-c:v', 'libx264',
          '-preset', 'ultrafast', '-g', '12', '-c:a', 'aac', '-f', 'mpegts', file]);
      }
      expect(await prepareSeamCopy([prior], next, output)).toBeUndefined();
      expect(fs.existsSync(output)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

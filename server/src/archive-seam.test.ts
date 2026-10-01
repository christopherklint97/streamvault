import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchedPrefix, fullDuplicateInSameWindow, prepareSeamCopy, processArchiveSeam,
  frameAccurateEnabledFor, allowDamagedTerminalPicture, localizedTerminalDecoderError } from './archive-seam.js';
import Database from 'better-sqlite3';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';

const run = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout: 30_000 });

describe('conservative TS seam copy', () => {
  it('localizes a single decoder error to the final picture rather than an earlier or mixed error', () => {
    const damaged = '[h264 @ 0x1234] error while decoding MB 51 5, bytestream -6';
    const terminal = '[dec:h264] decoder -> pts:1404000 pts_time:15.6 pkt_dts:1404000';
    const early = '[dec:h264] decoder -> pts:180000 pts_time:2 pkt_dts:180000';
    const companions = '[h264 @ 0x1234] concealing 3198 DC, 3198 AC, 3198 MV errors in P frame\n' +
      '[vist#0:0/h264 @ 0x5678] [dec:h264 @ 0x9abc] corrupt decoded frame';
    expect(localizedTerminalDecoderError(`${damaged}\n${terminal}`, 15.6, 50)).toBe(true);
    expect(localizedTerminalDecoderError(`${damaged}\n${companions}\n${terminal}`, 15.6, 50)).toBe(true);
    const near = '[dec:h264] decoder -> pts:1398600 pts_time:15.54 pkt_dts:1398600';
    const reordered = `[h264 @ 0x1234] concealing 232 DC, 232 AC, 232 MV errors in I frame\n${near}\n` +
      '[vist#0:0/h264 @ 0x5678] [dec:h264 @ 0x9abc] corrupt decoded frame';
    expect(localizedTerminalDecoderError(`${damaged}\n${reordered}\n${terminal}`, 15.6, 50)).toBe(true);
    expect(localizedTerminalDecoderError(`${damaged}\n${reordered}\n${early}`, 15.6, 50)).toBe(false);
    expect(localizedTerminalDecoderError(`${damaged}\n${early}\n${reordered}\n${terminal}`, 15.6, 50)).toBe(false);
    expect(localizedTerminalDecoderError(`${damaged}\n${companions}\n${early}`, 15.6, 50)).toBe(false);
    expect(localizedTerminalDecoderError(`${damaged}\n${terminal}\n[h264 @ 0x1234] invalid NAL`, 15.6, 50)).toBe(false);
    expect(localizedTerminalDecoderError(`${damaged}\n${early}\n${damaged}\n${terminal}`, 15.6, 50)).toBe(false);
  });
  it('accepts at most one damaged terminal picture only with a decoder corruption signal', () => {
    expect(allowDamagedTerminalPicture(0, false)).toBe(true);
    expect(allowDamagedTerminalPicture(1, true)).toBe(true);
    expect(allowDamagedTerminalPicture(1, false)).toBe(false);
    expect(allowDamagedTerminalPicture(2, true)).toBe(false);
    expect(allowDamagedTerminalPicture(-1, true)).toBe(false);
  });
  it.skipIf(!process.env.STREAMVAULT_TV4_TORN_SAMPLE)(
    'removes the GOP replay after a real TV4 one-frame torn predecessor without losing raw media', async () => {
      const base = process.env.STREAMVAULT_TV4_TORN_SAMPLE!;
      const files = ['older.ts', 'prior.ts', 'raw.ts'].map(name => path.join(base, name));
      for (const file of files) expect(fs.statSync(file).isFile()).toBe(true);
      const initial = files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tv4-torn-'));
      try {
        const result = await prepareSeamCopy(files.slice(0, 2), files[2], path.join(dir, 'playback.ts'), undefined, true);
        expect(result?.kind).toBe('trim');
        if (result?.kind !== 'trim') throw new Error('expected frame-accurate TV4 trim');
        expect(result.offset).toBeCloseTo(15.6, 2);
        const output = path.join(dir, 'playback.ts');
        const frameCount = (file: string) => Number((JSON.parse(execFileSync('ffprobe',
          ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
            'stream=nb_read_frames', '-of', 'json', file], { timeout: 30_000 }).toString()) as
          { streams: Array<{ nb_read_frames: string }> }).streams[0].nb_read_frames);
        expect(frameCount(output)).toBe(frameCount(files[2]) - Math.round(result.offset * 50));
        const visual = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostdin',
          '-i', files[2], '-i', output,
          '-filter_complex', `[0:v]trim=start_frame=${Math.round(result.offset * 50)},setpts=PTS-STARTPTS[ref];` +
            '[1:v]setpts=PTS-STARTPTS[got];[ref][got]ssim', '-an', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 45_000 });
        expect(visual.status).toBe(0);
        const similarity = /All:([0-9.]+)/.exec(visual.stderr)?.[1];
        expect(Number(similarity)).toBeGreaterThan(0.98);
        const audioHashes = (file: string): string[] =>
          (JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
            '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash',
            '-of', 'json', file], { timeout: 30_000 }).toString()) as
            { packets: Array<{ data_hash: string }> }).packets.map(packet => packet.data_hash);
        const previousAudio = audioHashes(files[1]);
        const rawAudio = audioHashes(files[2]);
        const copiedAudio = audioHashes(output);
        expect(previousAudio.at(-1)).toBe(rawAudio[previousAudio.length - 1]);
        expect(copiedAudio).toEqual(rawAudio.slice(previousAudio.length));
        expect(files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs })))
          .toEqual(initial);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 120_000);
  it.skipIf(!process.env.STREAMVAULT_TV4_REORDERED_SAMPLE)(
    'retains the unique tail and exact AAC when a B-frame precedes terminal corruption', async () => {
      const base = process.env.STREAMVAULT_TV4_REORDERED_SAMPLE!;
      const files = ['older.ts', 'prior.ts', 'raw.ts'].map(name => path.join(base, name));
      const initial = files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tv4-bframe-'));
      try {
        const output = path.join(dir, 'playback.ts');
        const result = await prepareSeamCopy(files.slice(0, 2), files[2], output, undefined, true);
        expect(result?.kind).toBe('trim');
        if (result?.kind !== 'trim') throw new Error('expected frame-accurate TV4 trim');
        expect(result.offset).toBeCloseTo(17.28, 2);
        const frameCount = (file: string) => Number((JSON.parse(execFileSync('ffprobe',
          ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
            'stream=nb_read_frames', '-of', 'json', file], { timeout: 30_000 }).toString()) as
          { streams: Array<{ nb_read_frames: string }> }).streams[0].nb_read_frames);
        expect(frameCount(output)).toBe(frameCount(files[2]) - Math.round(result.offset * 50));
        const visual = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostdin',
          '-i', files[2], '-i', output,
          '-filter_complex', `[0:v]trim=start_frame=${Math.round(result.offset * 50)},setpts=PTS-STARTPTS[ref];` +
            '[1:v]setpts=PTS-STARTPTS[got];[ref][got]ssim', '-an', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 45_000 });
        expect(visual.status).toBe(0);
        expect(Number(/All:([0-9.]+)/.exec(visual.stderr)?.[1])).toBeGreaterThan(0.98);
        const audioHashes = (file: string): string[] =>
          (JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
            '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash',
            '-of', 'json', file], { timeout: 30_000 }).toString()) as
            { packets: Array<{ data_hash: string }> }).packets.map(packet => packet.data_hash);
        const rawAudio = audioHashes(files[2]); const copiedAudio = audioHashes(output);
        const start = rawAudio.indexOf(copiedAudio[0]);
        expect(start).toBeGreaterThan(0);
        expect(copiedAudio).toEqual(rawAudio.slice(start));
        expect(audioHashes(files[1]).at(-1)).toBe(rawAudio[start - 1]);
        expect(files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs })))
          .toEqual(initial);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 120_000);
  it('gates frame-accurate re-encoding to explicitly named fresh channels', () => {
    const now = 10_000_000;
    try {
      vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_SEAMS', '1');
      vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_CHANNEL_IDS', 'live_44115');
      expect(frameAccurateEnabledFor('live_44115', now - 30_000, now)).toBe(true);
      expect(frameAccurateEnabledFor('live_1015944', now - 30_000, now)).toBe(false);
      expect(frameAccurateEnabledFor('live_44115', now - 300_001, now)).toBe(false);
      expect(frameAccurateEnabledFor('live_44115', now + 1, now)).toBe(false);
      vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_CHANNEL_IDS', '');
      expect(frameAccurateEnabledFor('live_44115', now - 1000, now)).toBe(false);
      vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_CHANNEL_IDS', 'live_44115');
      vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_SEAMS', '0');
      expect(frameAccurateEnabledFor('live_44115', now - 1000, now)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('starts an opted-in seam at the first unique decoded picture rather than replaying a GOP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-frame-seam-'));
    vi.stubEnv('STREAMVAULT_FRAME_ACCURATE_SEAMS', '1');
    try {
      const master = path.join(dir, 'master.ts');
      const previous = path.join(dir, 'previous.ts');
      const next = path.join(dir, 'next.ts');
      const output = path.join(dir, 'next.playback.ts');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=12',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=12',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-keyint_min', '24',
        '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', master]);
      run(['-ss', '0', '-i', master, '-t', '7', '-c', 'copy', '-f', 'mpegts', previous]);
      run(['-ss', '4', '-i', master, '-t', '8', '-c', 'copy', '-f', 'mpegts', next]);
      const before = fs.statSync(next);
      const result = await prepareSeamCopy([previous], next, output);
      expect(result?.kind).toBe('trim');
      if (result?.kind !== 'trim') return;
      expect(result.offset).toBeGreaterThan(2.8);
      expect(result.offset).toBeLessThan(3.2);
      const count = (file: string) => Number((JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames',
        '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of',
        'json', file]).toString()) as { streams: Array<{ nb_read_frames: string }> }).streams[0].nb_read_frames);
      expect(count(output)).toBe(count(next) - count(previous) + 48);
      const audioHashes = (file: string): string[] =>
        (JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
          '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash',
          '-of', 'json', file]).toString()) as { packets: Array<{ data_hash: string }> })
          .packets.map(packet => packet.data_hash);
      const rawAudio = audioHashes(next); const copiedAudio = audioHashes(output);
      const audioStart = rawAudio.indexOf(copiedAudio[0]);
      expect(audioStart).toBeGreaterThan(0);
      expect(copiedAudio).toEqual(rawAudio.slice(audioStart));
      expect(fs.statSync(next).size).toBe(before.size);
      expect(fs.statSync(next).mtimeMs).toBe(before.mtimeMs);
    } finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
  it('keeps a new snapshot raw when a predecessor is pruned during derivative publication', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seam-prune-race-'));
    const db = new Database(':memory:'); ensureArchiveSchema(db);
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const master = path.join(dir, 'master.ts');
      const earlier = path.join(dir, 'earlier.ts');
      const prior = path.join(dir, 'prior.ts');
      const next = path.join(dir, 'next.ts');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-keyint_min', '12',
        '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', master]);
      for (const [start, seconds, output] of [[0, 5, earlier], [5, 2, prior], [3, 7, next]] as const)
        run(['-ss', String(start), '-i', master, '-t', String(seconds), '-c', 'copy', '-f', 'mpegts', output]);
      const store = createArchiveStore(db); store.configure('espn', 'ESPN', true, 24);
      const ids = ['11111111-1111-4111-8111-111111111111-chunk-000000000.ts',
        '11111111-1111-4111-8111-111111111111-chunk-000000001.ts',
        '22222222-2222-4222-8222-222222222222-chunk-000000000.ts'];
      for (const [i, file] of [earlier, prior, next].entries()) store.publish({ id: ids[i],
        channelId: 'espn', start: [0, 5000, 7000][i], end: [5000, 7000, 14_000][i],
        duration: [5, 2, 7][i], path: path.relative(dir, file), size: fs.statSync(file).size, epoch: 1 });
      const realRename = fsPromises.rename.bind(fsPromises);
      rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        await realRename(from, to);
        expect(store.pruneChunk('espn', ids[0], 25 * 3_600_000, chunk =>
          fs.unlinkSync(path.join(dir, chunk.path)))).toBe(true);
      });
      expect(await processArchiveSeam(store, dir, ids[2], 2, 0)).toBe(false);
      expect(store.getChunk(ids[2])?.playbackPath).toBeNull();
      expect(fs.existsSync(next)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'next.playback.ts'))).toBe(false);
    } finally { rename?.mockRestore(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

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

  it('does not trim a partial overlap whose AAC and H264 occur at different prior-media times', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seam-offset-'));
    try {
      const master = path.join(dir, 'master.ts');
      const contiguous = path.join(dir, 'contiguous.ts');
      const prior = path.join(dir, 'prior.ts');
      const next = path.join(dir, 'next.ts');
      const output = path.join(dir, 'next.playback.ts');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=10',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-keyint_min', '12',
        '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', master]);
      run(['-ss', '0', '-i', master, '-t', '7', '-c', 'copy', '-f', 'mpegts', contiguous]);
      run(['-ss', '3', '-i', master, '-t', '7', '-c', 'copy', '-f', 'mpegts', next]);
      // Identical packets in each elementary stream, but the previous AAC
      // was delayed by two seconds; its match is not at the video's position.
      run(['-i', contiguous, '-itsoffset', '2', '-i', contiguous, '-map', '0:v:0',
        '-map', '1:a:0', '-c', 'copy', '-f', 'mpegts', prior]);
      expect(await prepareSeamCopy([prior], next, output)).toBeUndefined();
      expect(fs.existsSync(output)).toBe(false);
      const db = new Database(':memory:'); ensureArchiveSchema(db);
      try {
        const store = createArchiveStore(db); store.configure('shifted-av', 'Shifted AV', true, 24);
        const priorId = '11111111-1111-4111-8111-111111111111-chunk-000000001.ts';
        const nextId = '22222222-2222-4222-8222-222222222222-chunk-000000000.ts';
        for (const [id, file, start] of [[priorId, prior, 0], [nextId, next, 7000]] as const)
          store.publish({ id, channelId: 'shifted-av', start, end: start + 7000, duration: 7,
            path: path.relative(dir, file), size: fs.statSync(file).size, epoch: 1 });
        expect(await processArchiveSeam(store, dir, nextId, 2, 0)).toBe(false);
        expect(store.getChunk(nextId)?.playbackHidden).toBe(0);
        expect(store.getChunk(nextId)?.playbackPath).toBeNull();
        expect(fs.existsSync(next)).toBe(true);
        expect(fs.existsSync(output)).toBe(false);
      } finally { db.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.skipIf(process.env.STREAMVAULT_ESPN_SAMPLE !== '1')(
    'repairs the opt-in ESPN sample across both preceding chunks without touching its masters', async () => {
      const base = '/home/christopherklint/.hermes/cache/scratch/espn-check-0-';
      const files = [0, 1, 2].map(n => `${base}${n}.ts`);
      for (const file of files) expect(fs.existsSync(file)).toBe(true);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-espn-'));
      try {
        const before = files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }));
        const result = await prepareSeamCopy(files.slice(0, 2), files[2], path.join(dir, 'playback.ts'));
        expect(result?.kind).toBe('trim');
        if (result?.kind !== 'trim') throw new Error('expected verified ESPN partial trim');
        expect(result.offset).toBeGreaterThan(14.5);
        expect(result.offset).toBeLessThan(15.5);
        expect(result.duration).toBeGreaterThan(2);
        expect(files.map(file => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs })))
          .toEqual(before);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 60_000);

  it.each(['live_44115', 'live_1015944', 'live_17289'])(
    'preserves unique tail for %s after a verified AAC and H264 prefix overlap', async channelId => {
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
      const store = createArchiveStore(db); store.configure(channelId, channelId, true, 24);
      const sessionA = '11111111-1111-4111-8111-111111111111';
      const sessionB = '22222222-2222-4222-8222-222222222222';
      for (const [id, file, start, duration] of [
        [`${sessionA}-chunk-000000000.ts`, earlier, 0, 5],
        [`${sessionA}-chunk-000000001.ts`, prior, 5000, 2],
        [`${sessionB}-chunk-000000000.ts`, next, 7000, 7],
      ] as const) store.publish({ id, channelId, start, end: start + duration * 1000,
        duration, path: path.relative(dir, file), size: fs.statSync(file).size, epoch: 1 });
      fs.unlinkSync(output);
      const target = `${sessionB}-chunk-000000000.ts`;
      const pin = store.createSnapshot(channelId, 7000, 14_000, 1, 100);
      expect(await processArchiveSeam(store, dir, target, 2, 0,
        store.totalUsageBytes() + Math.ceil(fs.statSync(next).size * 1.5) - 1)).toBe(false);
      expect(store.getChunk(target)?.playbackPath).toBeNull();
      expect(await processArchiveSeam(store, dir, target, 2, 0)).toBe(true);
      expect(store.snapshot(pin.id)?.chunks.at(-1)?.playbackPath).toBeNull();
      const fresh = store.createSnapshot(channelId, 7000, 14_000, 3, 100);
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

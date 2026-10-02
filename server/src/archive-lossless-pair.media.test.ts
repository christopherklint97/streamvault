import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareLosslessPair, lowPriorityMediaCommand, rawTransportContinues,
  rawMediaClockContinues } from './archive-lossless-pair-media.js';

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout: 30000 });
const hashes = (file: string, stream: number): string[] => {
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=stream_index,data_hash', '-of', 'json', file], { timeout: 15000 }).toString()) as
    { packets: Array<{ stream_index: number; data_hash: string }> };
  return p.packets.filter(packet => packet.stream_index === stream).map(packet => packet.data_hash);
};
const verifyFiniteJoin = (dir: string, first: string, second: string, durations: [number, number]) => {
  const manifest = path.join(dir, 'joined.m3u8');
  fs.writeFileSync(manifest, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' +
    Math.ceil(Math.max(...durations)) + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    `#EXTINF:${durations[0].toFixed(3)},\n${path.basename(first)}\n` +
    `#EXTINF:${durations[1].toFixed(3)},\n${path.basename(second)}\n#EXT-X-ENDLIST\n`);
  const output = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '1', '-v', 'warning',
    '-allowed_extensions', 'ALL', '-i', manifest, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'],
  { timeout: 45000, encoding: 'utf8', maxBuffer: 64 * 1024 });
  expect(output.status).toBe(0);
  expect(output.stderr.split(/\r?\n/).filter(line => line &&
    !/^\[(?:h264|NULL) @ 0x[0-9a-f]+\] non-existing SPS 0 referenced in buffering period$/.test(line) &&
    !/^\s+Last message repeated \d+ times$/.test(line))).toEqual([]);
  for (const time of [durations[0] - 0.4, durations[0] + 0.4,
    durations[0] - 1.5, durations[0] + 1.5]) {
    // Output-side seek decodes through the boundary; input-side FFmpeg fast
    // seek may jump ahead to the next GOP within an HLS segment.
    const seek = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '1', '-v', 'error',
      '-allowed_extensions', 'ALL', '-i', manifest, '-ss', time.toFixed(3),
      '-t', '0.5', '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
    { timeout: 30000, encoding: 'utf8', maxBuffer: 128 * 1024 });
    expect(seek.status).toBe(0);
    expect(seek.stdout.split('\n').filter(line => line && !line.startsWith('#')).length).toBeGreaterThan(5);
    expect(seek.stderr).not.toMatch(/Packet corrupt|out of order|corrupt decoded frame|error while decoding/i);
  }
};

const verifyFollowingRaw = (dir: string, first: string, second: string, following: string,
  durations: [number, number, number]) => {
  const manifest = path.join(dir, 'through-following.m3u8');
  fs.writeFileSync(manifest, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' +
    Math.ceil(Math.max(...durations)) + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    `#EXTINF:${durations[0].toFixed(3)},\n${first}\n` +
    `#EXTINF:${durations[1].toFixed(3)},\n${second}\n` +
    `#EXT-X-DISCONTINUITY\n#EXTINF:${durations[2].toFixed(3)},\n${following}\n#EXT-X-ENDLIST\n`);
  const run = (args: string[]) => spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '1',
    '-allowed_extensions', 'ALL', '-i', manifest, ...args],
  { timeout: 60000, encoding: 'utf8', maxBuffer: 128 * 1024 });
  const decode = run(['-v', 'warning', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  expect(decode.status).toBe(0);
  expect(decode.stderr).not.toMatch(/Packet corrupt|corrupt input packet|error while decoding|corrupt decoded frame/i);
  const boundary = durations[0] + durations[1];
  for (const time of [boundary - 0.4, boundary + 0.4]) {
    const seek = run(['-v', 'error', '-ss', time.toFixed(3), '-t', '0.5',
      '-map', '0:v:0', '-an', '-f', 'framemd5', '-']);
    expect(seek.status).toBe(0);
    expect(seek.stdout.split('\n').filter(line => line && !line.startsWith('#')).length).toBeGreaterThan(5);
    expect(seek.stderr).not.toMatch(/Packet corrupt|corrupt input packet|error while decoding|corrupt decoded frame/i);
  }
};

describe('verified stream-copy pair', () => {
  it('runs packet inventories and remuxes below capture CPU and IO priority', () => {
    for (const tool of ['ffprobe', 'ffmpeg'] as const)
      expect(lowPriorityMediaCommand(tool, ['-v', 'error'])).toEqual({
        file: 'nice', args: ['-n', '15', 'ionice', '-c', '3', tool, '-v', 'error'],
      });
  });
  it.skipIf(!process.env.STREAMVAULT_F1_SEAM_SAMPLE || !process.env.STREAMVAULT_ESPN_SEAM_SAMPLE)(
    'requires real successor TS continuity before choosing a future raw segment', async () => {
      for (const base of [process.env.STREAMVAULT_F1_SEAM_SAMPLE!, process.env.STREAMVAULT_ESPN_SEAM_SAMPLE!]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-following-'));
        try {
          expect(await rawTransportContinues(path.join(base, 'next.ts'), path.join(base, 'after.ts'))).toBe(true);
          expect(await rawMediaClockContinues(path.join(base, 'next.ts'), path.join(base, 'after.ts'))).toBe(true);
          const delayed = path.join(dir, 'delayed.ts');
          ffmpeg(['-itsoffset', '2', '-i', path.join(base, 'after.ts'), '-map', '0:v:0', '-map', '0:a:0',
            '-c', 'copy', '-f', 'mpegts', delayed]);
          expect(await rawMediaClockContinues(path.join(base, 'next.ts'), delayed)).toBe(false);
          const changed = fs.readFileSync(path.join(base, 'after.ts'));
          const packet = changed.findIndex((byte, index) => index % 188 === 0 && byte === 0x47 &&
            ((((changed[index + 1] ?? 0) & 31) << 8) | (changed[index + 2] ?? 0)) === 256 &&
            (((changed[index + 3] ?? 0) >> 4) & 1) === 1);
          expect(packet).toBeGreaterThanOrEqual(0);
          changed[packet + 3] ^= 1;
          const broken = path.join(dir, 'broken.ts'); fs.writeFileSync(broken, changed);
          expect(await rawTransportContinues(path.join(base, 'next.ts'), broken)).toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    }, 20000);
  it('retains each H.264 and AAC packet exactly once across an overlapping reconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lossless-pair-'));
    try {
      const master = path.join(dir, 'master.ts');
      const previous = path.join(dir, 'previous.ts');
      const next = path.join(dir, 'next.ts');
      const priorPresentation = path.join(dir, 'prior.playback.ts');
      const nextPresentation = path.join(dir, 'next.playback.ts');
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=11',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=11',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', master]);
      ffmpeg(['-i', master, '-t', '6.4', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', previous]);
      ffmpeg(['-i', master, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', next]);
      const originalBytes = fs.readFileSync(previous);
      await expect(prepareLosslessPair(previous, next, previous, nextPresentation))
        .rejects.toThrow('new and distinct');
      expect(fs.readFileSync(previous)).toEqual(originalBytes);
      const result = await prepareLosslessPair(previous, next, priorPresentation, nextPresentation);
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.cut.videoBefore).toBe(150);
      for (const stream of [0, 1]) expect([...hashes(priorPresentation, stream), ...hashes(nextPresentation, stream)])
        .toEqual(hashes(next, stream));
      verifyFiniteJoin(dir, priorPresentation, nextPresentation, [result.cut.offset, 11 - result.cut.offset]);
      expect(fs.statSync(previous).size).toBeGreaterThan(0);
      expect(fs.statSync(next).size).toBeGreaterThan(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90000);
  it.skipIf(!process.env.STREAMVAULT_F1_SEAM_SAMPLE)(
    'removes damaged terminal F1 frame using the exact duplicate from the next segment', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-f1-pair-'));
      try {
        const base = process.env.STREAMVAULT_F1_SEAM_SAMPLE!;
        const previous = path.join(base, 'prev.ts');
        const next = path.join(base, 'next.ts');
        const first = path.join(dir, 'previous.ts');
        const second = path.join(dir, 'next.ts');
        const result = await prepareLosslessPair(previous, next, first, second);
        expect(result?.cut).toMatchObject({ videoBefore: 672, audioBefore: 630,
          videoAfter: 384, audioAfter: 360, droppedDamagedPictures: 1 });
        for (const stream of [0, 1]) expect([...hashes(first, stream), ...hashes(second, stream)])
          .toEqual(hashes(next, stream));
        verifyFiniteJoin(dir, first, second, [result!.cut.offset, 21.12 - result!.cut.offset]);
        verifyFollowingRaw(dir, first, second, path.join(base, 'after.ts'),
          [result!.cut.previousOffset, 21.12 - result!.cut.offset, 19.2]);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 120000);
  it.skipIf(!process.env.STREAMVAULT_ESPN_SEAM_SAMPLE)(
    'removes a short ESPN replay and one terminal damaged picture without losing prior unique frames', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-espn-pair-'));
      try {
        const base = process.env.STREAMVAULT_ESPN_SEAM_SAMPLE!;
        const previous = path.join(base, 'prev.ts');
        const next = path.join(base, 'next.ts');
        const first = path.join(dir, 'previous.ts');
        const second = path.join(dir, 'next.ts');
        const result = await prepareLosslessPair(previous, next, first, second);
        expect(result?.cut).toMatchObject({ videoBefore: 443, audioBefore: 694,
          videoAfter: 478, audioAfter: 747, videoOverlapStart: 300,
          audioOverlapStart: 469, droppedDamagedPictures: 1 });
        if (!result) return;
        for (const [stream, overlapStart] of [[0, 300], [1, 469]] as const)
          expect([...hashes(first, stream), ...hashes(second, stream)])
            .toEqual([...hashes(previous, stream).slice(0, overlapStart), ...hashes(next, stream)]);
        verifyFiniteJoin(dir, first, second, [result.cut.previousOffset, 20.7207 - result.cut.offset]);
        verifyFollowingRaw(dir, first, second, path.join(base, 'after.ts'),
          [result.cut.previousOffset, 20.7207 - result.cut.offset, 20.02]);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 120000);
});

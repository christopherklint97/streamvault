import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIosHlsArgs, probeIosHlsMediaModes, probeIosHlsVideoMode } from './ios-hls';

const execFileAsync = promisify(execFile);

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-ios-hls-probe-'));
const h264Fixture = path.join(fixtureDir, 'h264.mp4');
const mpeg4Fixture = path.join(fixtureDir, 'mpeg4.mp4');
// Matroska with B-frame H.264 and AC-3, like provider episodes whose audio is re-encoded.
const mixedFixture = path.join(fixtureDir, 'mixed.mkv');
let fixtureServer: http.Server;
let fixtureBaseUrl = '';

beforeAll(() => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    h264Fixture,
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=1',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
    mpeg4Fixture,
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '12',
    '-c:v', 'libx264', '-bf', '2', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-ac', '2',
    mixedFixture,
  ]);
});

beforeAll(async () => {
  // The session arguments carry HTTP reconnect options, so serve the fixture
  // over HTTP with byte ranges like the loopback stream proxy.
  fixtureServer = http.createServer((req, res) => {
    const file = path.join(fixtureDir, path.basename(req.url ?? ''));
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureBaseUrl = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  fixtureServer?.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('iOS HLS codec probe', () => {
  it('selects stream copy for real compatible H.264 and AAC streams', async () => {
    await expect(probeIosHlsMediaModes(h264Fixture)).resolves.toEqual({ video: 'copy', audio: 'copy' });
  });

  it('selects stream copy for a real compatible H.264 asset', async () => {
    await expect(probeIosHlsVideoMode(h264Fixture)).resolves.toBe('copy');
  });

  it('selects transcoding for a real incompatible MPEG-4 Part 2 asset', async () => {
    await expect(probeIosHlsVideoMode(mpeg4Fixture)).resolves.toBe('transcode');
  });
});

describe('iOS HLS session output', () => {
  it('writes no edit list that would offset copied video from re-encoded audio', async () => {
    const outputDir = path.join(fixtureDir, 'session');
    fs.mkdirSync(outputDir);
    const playlist = path.join(outputDir, 'index.m3u8');
    await execFileAsync('ffmpeg', buildIosHlsArgs(`${fixtureBaseUrl}/mixed.mkv`, playlist, 5, 'copy', 'transcode'), { timeout: 30_000 });

    // FFmpeg 9 wrote a ~4 s empty video edit here; iPhones never started playback.
    const init = fs.readFileSync(path.join(outputDir, 'init.mp4'));
    expect(init.includes('elst')).toBe(false);

    // One trun per track means all video precedes all audio in the segment,
    // which iPhones refuse at 1080p bitrates; interleaving yields many runs.
    const segment = fs.readFileSync(path.join(outputDir, 'segment-00000.m4s'));
    let runs = 0;
    for (let at = segment.indexOf('trun'); at >= 0; at = segment.indexOf('trun', at + 4)) runs++;
    expect(runs).toBeGreaterThan(2);

    const firstSegment = path.join(outputDir, 'first.mp4');
    fs.writeFileSync(firstSegment, Buffer.concat([init, fs.readFileSync(path.join(outputDir, 'segment-00000.m4s'))]));
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time', '-of', 'json', firstSegment,
    ]).toString()) as { streams: { codec_type: string; codec_name: string; start_time: string }[] };
    const video = probe.streams.find(stream => stream.codec_type === 'video')!;
    const audio = probe.streams.find(stream => stream.codec_type === 'audio')!;
    expect(video.codec_name).toBe('h264');
    expect(audio.codec_name).toBe('aac');
    expect(Math.abs(Number(video.start_time) - Number(audio.start_time))).toBeLessThan(0.5);
  }, 60_000);
});

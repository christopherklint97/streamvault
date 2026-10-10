import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveBuffer, createLiveRouter } from './live-buffer.js';

let root: string;
let buffer: ReturnType<typeof createLiveBuffer>;
let server: Server;
afterEach(async () => {
  if (buffer) await buffer.stop();
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.STREAMVAULT_AUTH_TOKEN;
});

function media(command: string, args: string[]) {
  const result = spawnSync(command, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}
function crc32mpeg(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

/** Synthetic DVB display sets, not a broadcast recording. Add an EN 300 468
 * subtitling descriptor to each PMT and EN 300 743 empty acquisition pages at
 * the generated video's PTS. MPEG-TS/PES framing and DVB packets are real;
 * empty pages intentionally exercise stream-copy, not caption rendering. */
function addDvbSubtitles(av: Buffer): Buffer {
  const packets: Buffer[] = [];
  let continuity = 0;
  let pictures = 0;
  for (let pos = 0; pos < av.length; pos += 188) {
    const packet = Buffer.from(av.subarray(pos, pos + 188));
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const payload = 4 + (packet[3] & 0x20 ? 1 + packet[4] : 0);
    if (pid === 0x1000 && packet[1] & 0x40) {
      const start = payload + 1 + packet[payload];
      const length = 3 + (((packet[start + 1] & 15) << 8) | packet[start + 2]);
      const section = Buffer.concat([packet.subarray(start, start + length - 4),
        // private PES PID 0x120, ISO639 eng, normal DVB subtitle, page IDs 1/1
        Buffer.from([0x06, 0xe1, 0x20, 0xf0, 0x0a, 0x59, 0x08, 0x65, 0x6e, 0x67, 0x10, 0, 1, 0, 1]), Buffer.alloc(4)]);
      section[1] = 0xb0 | ((section.length - 3) >> 8);
      section[2] = (section.length - 3) & 0xff;
      section.writeUInt32BE(crc32mpeg(section.subarray(0, -4)), section.length - 4);
      expect(start + section.length).toBeLessThanOrEqual(188);
      packet.fill(0xff, start); section.copy(packet, start);
    }
    packets.push(packet);
    if (pid === 0x100 && packet[1] & 0x40 && packet[payload + 7] & 0x80 && pictures++ % 10 === 0) {
      const pts = packet.subarray(payload + 9, payload + 14);
      const display = Buffer.from([0x20, 0x00, 0x0f, 0x10, 0, 1, 0, 2, 1, 0x0c, 0x0f, 0x80, 0, 1, 0, 0, 0xff]);
      const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xbd, 0, 8 + display.length, 0x80, 0x80, 5]), pts, display]);
      const sub = Buffer.alloc(188, 0xff);
      sub.set([0x47, 0x41, 0x20, 0x30 | (continuity++ & 15), 183 - pes.length, 0]);
      pes.copy(sub, 5 + sub[4]); packets.push(sub);
    }
  }
  expect(continuity).toBeGreaterThan(1);
  return Buffer.concat(packets);
}
function inventory(file: string) {
  return JSON.parse(media('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file])) as {
    streams: { index: number; codec_type: string; codec_name: string }[];
    packets: { stream_index: number; data_hash: string }[];
  };
}

it('cold native compatibility startup preserves DVB subtitle packets and publishes decodable A/V over signed HTTP', async () => {
  root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'sv-live-dvb-'));
  const av = path.join(root, 'av.ts');
  const source = path.join(root, 'synthetic-dvb.ts');
  media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'aac', '-f', 'mpegts', av]);
  const body = addDvbSubtitles(await readFile(av));
  await writeFile(source, body);
  const original = inventory(source);
  expect(original.streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac', 'dvb_subtitle']);
  const subtitleIndex = original.streams.find(stream => stream.codec_type === 'subtitle')!.index;
  const originalSubtitles = original.packets.filter(packet => packet.stream_index === subtitleIndex).map(packet => packet.data_hash);
  expect(originalSubtitles.length).toBeGreaterThan(1);

  process.env.STREAMVAULT_AUTH_TOKEN = 'synthetic-dvb-test';
  buffer = createLiveBuffer({ root: path.join(root, 'cache'), packetAware: false, pollMs: 20, retryMs: 30_000 });
  const app = express();
  app.get('/source', (_req, res) => res.type('video/mp2t').end(body));
  let origin = '';
  app.use('/api/live-compatible', createLiveRouter(buffer, id => id === 'bbc-synthetic' ? `${origin}/source` : null,
    { basePath: '/api/live-compatible' }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  origin = `http://127.0.0.1:${address.port}`;
  // No prewarming: exercise the real cold native authorization deadline.
  const started = performance.now();
  const authorization = await fetch(`${origin}/api/live-compatible/bbc-synthetic/authorize`,
    { headers: { authorization: 'Bearer synthetic-dvb-test' } });
  expect(authorization.status, 'DVB subtitles must not leave native startup permanently warming').toBe(200);
  const startupMs = Math.round(performance.now() - started);
  const playlistUrl = new URL((await authorization.json()).playlistUrl, origin);
  const playlist = await fetch(playlistUrl);
  expect(playlist.status).toBe(200);
  let manifest = await playlist.text();
  const deadline = Date.now() + 2_000;
  while (manifest.split('\n').filter(line => line.startsWith('segment/')).length < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    manifest = await (await fetch(playlistUrl)).text();
  }
  expect(manifest).toContain('#EXT-X-TARGETDURATION:12');
  expect(manifest).not.toContain('#EXT-X-ENDLIST');
  const segments = manifest.split('\n').filter(line => line.startsWith('segment/'));
  expect(segments).toHaveLength(3);
  const publishedSubtitles: string[] = [];
  let decodedFrames = 0;
  for (const [index, segment] of segments.entries()) {
    const url = new URL(segment, playlistUrl);
    expect(url.searchParams.has('ticket')).toBe(true);
    const unauthorized = new URL(url); unauthorized.searchParams.delete('ticket');
    expect((await fetch(unauthorized)).status).toBe(401);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp2t');
    const file = path.join(root, `published-${index}.ts`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const published = inventory(file);
    expect(published.streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac', 'dvb_subtitle']);
    const subIndex = published.streams.find(stream => stream.codec_type === 'subtitle')!.index;
    publishedSubtitles.push(...published.packets.filter(packet => packet.stream_index === subIndex).map(packet => packet.data_hash));
    const decoded = media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
      '-map', '0:v:0', '-an', '-sn', '-f', 'framemd5', '-']);
    decodedFrames += decoded.split('\n').filter(line => /^0,/.test(line)).length;
  }
  expect(publishedSubtitles).toEqual(originalSubtitles);
  expect(decodedFrames).toBe(60);
  console.info(`DVB native startup: ${startupMs} ms; published codecs h264/aac/dvb_subtitle; ${publishedSubtitles.length} unchanged subtitle packets; ${decodedFrames} decoded video frames`);
  await buffer.stop();
  expect(await readdir(path.join(root, 'cache'))).toEqual([]);
}, 20_000);

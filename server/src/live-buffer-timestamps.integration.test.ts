import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** Distinct gaps between consecutive video presentation times, in 90 kHz ticks. */
function videoFrameGaps(file: string): Set<number> {
  const pts = media('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts',
    '-of', 'csv=p=0', file]).split('\n').map(line => parseInt(line, 10)).filter(Number.isFinite).sort((a, b) => a - b);
  return new Set(pts.slice(1).map((value, index) => value - pts[index]));
}

it.each([
  { rate: '30000/1001', gop: '60', gaps: [3003] },
  // 1501.5 ticks per frame cannot be exact at 90 kHz; alternating keeps the average.
  { rate: '60000/1001', gop: '120', gaps: [1501, 1502] },
])('compatible live evens out millisecond-rounded $rate frame timestamps', async ({ rate, gop, gaps }) => {
  root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'sv-live-timestamps-'));
  const source = path.join(root, 'source.ts');
  // FLV stores millisecond timestamps, like the providers whose frames arrive 33 and 34 ms apart.
  const flv = path.join(root, 'source.flv');
  media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${rate}:duration=7`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=7', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', gop, '-bf', '2', '-c:a', 'aac', '-f', 'flv', flv]);
  media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', flv, '-c', 'copy', '-f', 'mpegts', source]);
  expect([...videoFrameGaps(source)].sort(), 'fixture must have uneven frame timestamps').not.toEqual(gaps);

  const body = await readFile(source);
  process.env.STREAMVAULT_AUTH_TOKEN = 'synthetic-timestamps-test';
  buffer = createLiveBuffer({ root: path.join(root, 'cache'), packetAware: false, pollMs: 20, retryMs: 30_000 });
  const app = express();
  app.get('/source', (_req, res) => res.type('video/mp2t').end(body));
  let origin = '';
  app.use('/api/live-compatible', createLiveRouter(buffer, id => id === 'synthetic' ? `${origin}/source` : null,
    { basePath: '/api/live-compatible' }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  origin = `http://127.0.0.1:${address.port}`;

  const authorization = await fetch(`${origin}/api/live-compatible/synthetic/authorize`,
    { headers: { authorization: 'Bearer synthetic-timestamps-test' } });
  expect(authorization.status).toBe(200);
  const playlistUrl = new URL((await authorization.json()).playlistUrl, origin);
  let segments: string[] = [];
  const deadline = Date.now() + 5_000;
  while (segments.length < 3 && Date.now() < deadline) {
    segments = (await (await fetch(playlistUrl)).text()).split('\n').filter(line => line.startsWith('segment/'));
    if (segments.length < 3) await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(segments.length).toBeGreaterThanOrEqual(3);
  const published = await Promise.all(segments.map(async segment =>
    Buffer.from(await (await fetch(new URL(segment, playlistUrl))).arrayBuffer())));
  const joined = path.join(root, 'published.ts');
  await writeFile(joined, Buffer.concat(published));
  expect([...videoFrameGaps(joined)].sort()).toEqual(gaps);
  for (const [index, segment] of published.entries()) {
    const file = path.join(root, `published-${index}.ts`);
    await writeFile(file, segment);
    media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  }
}, 20_000);

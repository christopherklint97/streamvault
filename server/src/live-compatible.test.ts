import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn,
  // This routing/isolation test seeds fake TS bytes. Real media inventory and
  // unsupported-subtitle rejection are exercised by the integration suites.
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async () => ({
      stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '',
    })),
  }),
}));
import { createLiveBuffer, createLiveRouter } from './live-buffer.js';

let root: string;
let server: Server;
const buffers: ReturnType<typeof createLiveBuffer>[] = [];
const source = 'http://127.0.0.1:1/api/stream/channel-a?subs=1';
const auth = { headers: { authorization: 'Bearer synthetic-compatible-test' } };
afterEach(async () => {
  await Promise.all(buffers.splice(0).map(buffer => buffer.stop()));
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.STREAMVAULT_AUTH_TOKEN;
});
it('serves native-compatible signed HLS with independent tickets, cache epochs and primary unsafe state', async () => {
  process.env.STREAMVAULT_AUTH_TOKEN = 'synthetic-compatible-test';
  mocks.spawn.mockImplementation(() => {
    const worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
    return worker;
  });
  root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'sv-compatible-'));
  const primary = createLiveBuffer({ root: path.join(root, 'primary'), packetAware: true, pollMs: 10 });
  const compatible = createLiveBuffer({ root: path.join(root, 'compatible'), packetAware: false, maxChannels: 4, pollMs: 10 });
  buffers.push(primary, compatible);
  async function seed(buffer: typeof primary, dir: string) {
    await buffer.playlist('channel-a', source);
    let stage = '';
    await vi.waitFor(async () => {
      const [channel] = await readdir(dir);
      const ingest = (await readdir(path.join(dir, channel))).find(name => name.startsWith('ingest-'));
      expect(ingest).toBeTruthy();
      stage = path.join(dir, channel, ingest!);
    });
    await writeFile(path.join(stage, '0.ts'), Buffer.alloc(188));
    await writeFile(path.join(stage, 'index.m3u8'), '#EXTM3U\n#EXTINF:8.334,\n0.ts\n');
    await vi.waitFor(async () => expect(await buffer.playlist('channel-a', source)).toContain('segment/'));
    return stage;
  }
  const primaryStage = await seed(primary, path.join(root, 'primary'));
  await seed(compatible, path.join(root, 'compatible'));
  expect(mocks.spawn.mock.calls.map(([command]) => command)).toContain('ffmpeg');
  const app = express();
  const getSource = (id: string) => /^channel-[a-e]$/.test(id) ? source : null;
  app.use('/api/live', createLiveRouter(primary, getSource));
  app.use('/api/live-compatible', createLiveRouter(compatible, getSource, { basePath: '/api/live-compatible' }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  const origin = `http://127.0.0.1:${address.port}`;
  const primaryAuth = await fetch(`${origin}/api/live/channel-a/authorize`, auth);
  const compatibleAuth = await fetch(`${origin}/api/live-compatible/channel-a/authorize`, auth);
  expect(primaryAuth.status).toBe(200);
  expect(compatibleAuth.status).toBe(200);
  expect(compatibleAuth.headers.get('cache-control')).toBe('private, no-store');
  const primaryUrl = new URL((await primaryAuth.json()).playlistUrl, origin);
  const compatibleUrl = new URL((await compatibleAuth.json()).playlistUrl, origin);
  expect(compatibleUrl.pathname).toBe('/api/live-compatible/channel-a/index.m3u8');
  const primaryManifest = await (await fetch(primaryUrl)).text();
  const response = await fetch(compatibleUrl);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/application\/vnd.apple.mpegurl/);
  const manifest = await response.text();
  const segmentOf = (text: string, url: URL) => new URL(text.split('\n').find(line => line.startsWith('segment/'))!, url);
  const primarySegment = segmentOf(primaryManifest, primaryUrl);
  const compatibleSegment = segmentOf(manifest, compatibleUrl);
  expect(compatibleSegment.searchParams.get('epoch')).not.toBe(primarySegment.searchParams.get('epoch'));
  expect((await fetch(compatibleSegment)).status).toBe(200);
  for (const [url, other] of [[compatibleUrl, primaryUrl], [primaryUrl, compatibleUrl]]) {
    const wrongTicket = new URL(url);
    wrongTicket.searchParams.set('ticket', other.searchParams.get('ticket')!);
    expect((await fetch(wrongTicket)).status).toBe(401);
  }
  expect((await fetch(`${origin}/api/live-compatible/channel-a/authorize`)).status).toBe(401);
  expect((await fetch(`${origin}/api/live-compatible/missing/authorize`, auth)).status).toBe(404);
  expect((await fetch(`${origin}/api/live-compatible/channel-a/index.m3u8?audio=1`, auth)).status).toBe(422);
  const wrongEpoch = new URL(compatibleSegment);
  wrongEpoch.searchParams.set('epoch', primarySegment.searchParams.get('epoch')!);
  expect((await fetch(wrongEpoch)).status).toBe(404);
  await writeFile(path.join(primaryStage, 'UNSAFE'), 'synthetic-marker');
  await vi.waitFor(() => expect(primary.isUnsafe('channel-a')).toBe(true));
  expect((await fetch(primaryUrl)).status).toBe(501);
  expect((await fetch(primarySegment)).status).toBe(404);
  expect((await fetch(`${origin}/api/live/channel-a/authorize`, auth)).status).toBe(501);
  expect((await fetch(compatibleUrl)).status).toBe(200);
  expect((await fetch(compatibleSegment)).status).toBe(200);
  expect(compatible.isUnsafe('channel-a')).toBe(false);
  const cold = await fetch(`${origin}/api/live-compatible/channel-b/index.m3u8`, auth);
  expect(cold.status).toBe(503);
  expect(cold.headers.get('retry-after')).toBe('2');
  await compatible.playlist('channel-c', source);
  await compatible.playlist('channel-d', source);
  expect(compatible.activeCount).toBe(4);
  const capped = await fetch(`${origin}/api/live-compatible/channel-e/index.m3u8`, auth);
  expect(capped.status).toBe(503);
  expect(compatible.activeCount).toBe(4);
  await Promise.all([primary.stop(), compatible.stop()]);
  expect(primary.activeCount).toBe(0);
  expect(compatible.activeCount).toBe(0);
});

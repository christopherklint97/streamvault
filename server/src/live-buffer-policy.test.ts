import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { createLiveBuffer, createLiveRouter, LIVE_HLS_MAX_SEGMENT_SECONDS } from './live-buffer.js';

let root: string;
let buffer: ReturnType<typeof createLiveBuffer>;
let stage: string;
let server: Server;
let base: string;
const source = 'http://127.0.0.1:1/api/stream/channel-a';
const auth = { headers: { authorization: 'Bearer synthetic-token' } };
const unsafe = vi.fn();
beforeEach(async () => {
  process.env.STREAMVAULT_AUTH_TOKEN = 'synthetic-token';
  unsafe.mockClear(); mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
    return worker;
  });
  root = await mkdtemp(path.join(tmpdir(), 'sv-live-policy-'));
  buffer = createLiveBuffer({ root, packetAware: true, pollMs: 10, onUnsafe: unsafe });
  await buffer.playlist('channel-a', source);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  const [channel] = await readdir(root);
  const [ingest] = (await readdir(path.join(root, channel))).filter(name => name.startsWith('ingest-'));
  stage = path.join(root, channel, ingest);
  const app = express();
  app.use('/api/live', createLiveRouter(buffer, id => id === 'channel-a' ? source : null));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  base = `http://127.0.0.1:${address.port}/api/live/channel-a`;
});
afterEach(async () => {
  await buffer.stop();
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
  delete process.env.STREAMVAULT_AUTH_TOKEN;
});
async function publish(index: number, duration: string) {
  await writeFile(path.join(stage, `${index}.ts`), Buffer.alloc(188));
  await writeFile(path.join(stage, 'index.m3u8'), `#EXTM3U\n#EXTINF:${duration},\n${index}.ts\n`);
}
it('keeps a fixed twelve-second target as short and long GOPs arrive, including the upper bound', async () => {
  expect(LIVE_HLS_MAX_SEGMENT_SECONDS).toBe(12);
  for (const [index, duration] of ['2', '8.334', '8.333', '12'].entries()) {
    await publish(index, duration);
    await vi.waitFor(async () => {
      const manifest = await buffer.playlist('channel-a', source);
      expect(manifest).toContain(`#EXTINF:${Number(duration).toFixed(3)},`);
      expect(manifest).toContain('#EXT-X-TARGETDURATION:12\n');
    });
  }
  expect(unsafe).not.toHaveBeenCalled();
});
it.each([{ label: 'over twelve seconds', duration: '12.001' }, { label: 'zero', duration: '0' },
  { label: 'nonfinite', duration: '9'.repeat(400) }])('still latches an unpublishable duration: $label', async ({ duration }) => {
  await publish(0, duration);
  await vi.waitFor(() => expect(buffer.activeCount).toBe(0));
  expect(unsafe).toHaveBeenCalledExactlyOnceWith('unpublishable_stage', 'channel-a');
  expect(await buffer.playlist('channel-a', source)).toBeNull();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
it('reports a latched unsafe channel immediately as 501 without retry or stale ticket media', async () => {
  await publish(0, '2');
  await vi.waitFor(async () => expect(await buffer.playlist('channel-a', source)).toContain('segment/'));
  const authorization = await fetch(`${base}/authorize`, auth);
  expect(authorization.status).toBe(200);
  const { playlistUrl } = await authorization.json();
  const playlist = new URL(playlistUrl, base);
  const text = await (await fetch(playlist)).text();
  const segment = new URL(text.split('\n').find(line => line.startsWith('segment/'))!, playlist);
  expect((await fetch(segment)).status).toBe(200);
  await writeFile(path.join(stage, 'UNSAFE'), 'fixed-test-marker');
  await vi.waitFor(() => expect(buffer.activeCount).toBe(0));
  const started = performance.now();
  const rejected = await fetch(`${base}/authorize`, auth);
  expect(rejected.status).toBe(501);
  expect(rejected.headers.get('retry-after')).toBeNull();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(buffer.isUnsafe('channel-a')).toBe(true);
  expect(buffer.isUnsafe('channel-b')).toBe(false);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(playlist);
    expect(response.status).toBe(501);
    expect(response.headers.get('retry-after')).toBeNull();
    expect((await fetch(segment)).status).toBe(404);
    expect(await buffer.playlist('channel-a', source)).toBeNull();
  }
  expect((await fetch(`${base}/authorize`)).status).toBe(401);
  expect((await fetch(`${base}/index.m3u8`)).status).toBe(401);
  expect(unsafe).toHaveBeenCalledExactlyOnceWith('worker_unsafe', 'channel-a');
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(buffer.activeCount).toBe(0);
}, 10000);
it('still returns retryable 503 for genuine cold playlist and authorization warmup', async () => {
  const playlist = await fetch(`${base}/index.m3u8`, auth);
  expect(playlist.status).toBe(503);
  expect(playlist.headers.get('retry-after')).toBe('2');
  const authorization = await fetch(`${base}/authorize`, auth);
  expect(authorization.status).toBe(503);
  expect(authorization.headers.get('retry-after')).toBe('2');
  expect(buffer.activeCount).toBe(1);
  expect(unsafe).not.toHaveBeenCalled();
}, 10000);

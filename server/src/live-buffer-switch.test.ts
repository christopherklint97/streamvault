import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn,
}));
import { createLiveBuffer, createLiveClaims, createLiveRouter } from './live-buffer.js';

type Worker = EventEmitter & { exitCode: number | null; signalCode: null; kill: () => boolean; source?: string };
let root: string;
let buffer: ReturnType<typeof createLiveBuffer>;
const workers: Worker[] = [];
const servers: Server[] = [];
const extraBuffers: ReturnType<typeof createLiveBuffer>[] = [];
const sourceFor = (id: string) => `http://127.0.0.1:1/api/stream/${id}`;
const spawnsFor = (id: string) => workers.filter(worker => worker.source === sourceFor(id)).length;
beforeEach(async () => {
  workers.length = 0;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const worker: Worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      source: args[args.indexOf('-i') + 1],
      kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
    workers.push(worker);
    return worker;
  });
  root = await mkdtemp(path.join(tmpdir(), 'sv-live-switch-'));
  buffer = createLiveBuffer({ root, pollMs: 10, retryMs: 10 });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  await Promise.all(extraBuffers.splice(0).map(extra => extra.stop()));
  await buffer.stop();
  await rm(root, { recursive: true, force: true });
});

it('does not reconnect a channel the viewer switched away from', async () => {
  await buffer.playlist('a', 'http://127.0.0.1:1/api/stream/a');
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await buffer.playlist('b', 'http://127.0.0.1:1/api/stream/b');
  await vi.waitFor(() => expect(workers).toHaveLength(2));

  // The provider evicts a's upstream (one allowed connection); a must not
  // reconnect and evict b in turn.
  workers[0].exitCode = 0; workers[0].emit('close', 0);
  await vi.waitFor(() => expect(buffer.activeCount).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(workers).toHaveLength(2);

  // The watched channel still reconnects after an upstream drop.
  workers[1].exitCode = 0; workers[1].emit('close', 0);
  await vi.waitFor(() => expect(workers).toHaveLength(3));
});

it('lets a superseded channel reconnect once it is played again', async () => {
  await buffer.playlist('a', 'http://127.0.0.1:1/api/stream/a');
  await buffer.playlist('b', 'http://127.0.0.1:1/api/stream/b');
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  await new Promise(resolve => setTimeout(resolve, 5));
  await buffer.playlist('a', 'http://127.0.0.1:1/api/stream/a'); // another device still watches a
  workers[0].exitCode = 0; workers[0].emit('close', 0);
  await vi.waitFor(() => expect(workers).toHaveLength(3));
});

it('releases every other channel when a player starts one, including one switched back to', async () => {
  // FHD -> HD -> FHD within seconds: both are still polled, so idle checks keep both.
  await buffer.playlist('fhd', 'http://127.0.0.1:1/api/stream/fhd');
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await buffer.claim('hd');
  await buffer.playlist('hd', 'http://127.0.0.1:1/api/stream/hd');
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  expect(workers[0].kill).toHaveBeenCalled();

  await buffer.claim('fhd');
  await buffer.playlist('fhd', 'http://127.0.0.1:1/api/stream/fhd');
  await vi.waitFor(() => expect(workers).toHaveLength(3));
  expect(workers[1].kill).toHaveBeenCalled();
  expect(workers[2].kill).not.toHaveBeenCalled();
  expect(buffer.activeCount).toBe(1);
});

it('keeps the started channel when a player restarts it', async () => {
  await buffer.playlist('a', 'http://127.0.0.1:1/api/stream/a');
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await buffer.claim('a');
  expect(workers[0].kill).not.toHaveBeenCalled();
  expect(buffer.activeCount).toBe(1);
});

it('releases every channel when another kind of playback takes the provider connection', async () => {
  await buffer.playlist('a', 'http://127.0.0.1:1/api/stream/a');
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await buffer.releaseAll();
  expect(workers[0].kill).toHaveBeenCalled();
  expect(buffer.activeCount).toBe(0);
});

async function serve(router: ReturnType<typeof createLiveRouter>): Promise<string> {
  const app = express();
  app.use('/api/live', router);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  return `http://127.0.0.1:${address.port}/api/live`;
}

it('ends a left channel\'s authorization instead of reopening its upstream', async () => {
  // A feed that never publishes keeps the first authorization in its wait loop.
  const base = await serve(createLiveRouter(buffer, id => ['a', 'b'].includes(id) ? sourceFor(id) : null));
  const left = fetch(`${base}/a/authorize`);
  await vi.waitFor(() => expect(spawnsFor('a')).toBe(1));
  const controller = new AbortController();
  const current = fetch(`${base}/b/authorize`, { signal: controller.signal }).catch(() => null);
  await vi.waitFor(() => expect(spawnsFor('b')).toBe(1));

  const response = await left;
  expect(response.status).toBe(503);
  expect(spawnsFor('a')).toBe(1);
  expect(buffer.activeCount).toBe(1);

  // The channel being watched still reconnects after its upstream drops.
  const worker = workers.find(candidate => candidate.source === sourceFor('b'))!;
  worker.exitCode = 0; worker.emit('close', 0);
  await vi.waitFor(() => expect(spawnsFor('b')).toBe(2));
  expect(spawnsFor('a')).toBe(1);
  controller.abort();
  await current;
}, 10000);

it('serves no playlist and starts no worker for a stale poll of a channel the player left', async () => {
  await buffer.claim('a');
  await buffer.playlist('a', sourceFor('a'));
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await buffer.claim('b');
  await buffer.playlist('b', sourceFor('b'));
  await vi.waitFor(() => expect(workers).toHaveLength(2));

  expect(await buffer.playlist('a', sourceFor('a'))).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(spawnsFor('a')).toBe(1);
  expect(buffer.activeCount).toBe(1);
});

it('shares the newest claim between the primary and compatible buffers', async () => {
  const claims = createLiveClaims();
  await buffer.stop();
  buffer = createLiveBuffer({ root: path.join(root, 'primary'), pollMs: 10, retryMs: 10, claims });
  const compatible = createLiveBuffer({ root: path.join(root, 'compatible'), pollMs: 10, retryMs: 10, claims });
  extraBuffers.push(compatible);
  await buffer.claim('a');
  await buffer.playlist('a', sourceFor('a'));
  await vi.waitFor(() => expect(spawnsFor('a')).toBe(1));
  await compatible.claim('b');
  await buffer.releaseAll();

  // A primary poll for the left channel, or for the newly claimed one, opens nothing.
  expect(await buffer.playlist('a', sourceFor('a'))).toBeNull();
  expect(await buffer.playlist('b', sourceFor('b'))).toBeNull();
  expect(spawnsFor('a')).toBe(1);
  expect(spawnsFor('b')).toBe(0);

  // Other playback took the provider connection: nothing opens until a new claim.
  claims.revoke();
  expect(await compatible.playlist('b', sourceFor('b'))).toBeNull();
  expect(spawnsFor('b')).toBe(0);
  await compatible.claim('b');
  await compatible.playlist('b', sourceFor('b'));
  await vi.waitFor(() => expect(spawnsFor('b')).toBe(1));
});

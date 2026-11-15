import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn,
}));
import { createLiveBuffer, createLiveRouter } from './live-buffer.js';

// The provider rejects the connection (e.g. 403): the packet worker marks the
// attempt retryable and exits before accepting any media.
let source: 'rejected' | 'playable';
let root: string;
let buffer: ReturnType<typeof createLiveBuffer>;
let server: Server;
let base: string;
const sourceUrl = 'http://127.0.0.1:1/api/stream/channel-a';

beforeEach(async () => {
  source = 'rejected';
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const directory = args[args.indexOf('--directory') + 1];
    const worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
    const behaviour = source;
    setTimeout(() => void (async () => {
      if (behaviour === 'rejected') {
        await writeFile(path.join(directory, 'RETRYABLE'), '');
        worker.exitCode = 2; worker.emit('close', 2);
        return;
      }
      for (const index of [0, 1, 2]) await writeFile(path.join(directory, `${index}.ts`), Buffer.alloc(188));
      await writeFile(path.join(directory, 'index.m3u8'),
        [0, 1, 2].map(index => `#EXTINF:12,\n${index}.ts`).join('\n') + '\n');
    })().catch(() => {}), 20);
    return worker;
  });
  root = await mkdtemp(path.join(tmpdir(), 'sv-live-cooldown-'));
  buffer = createLiveBuffer({ root, packetAware: true, pollMs: 10, retryBackoffMs: [1_000, 2_000, 4_000] });
  const app = express();
  app.use('/api/live', createLiveRouter(buffer, id => id === 'channel-a' ? sourceUrl : null));
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
});

it('starts at most one worker per cooldown window while the provider rejects the channel', async () => {
  const startedAt = Date.now();
  const first = await fetch(`${base}/authorize`);
  expect(first.status).toBe(503);
  expect(first.headers.get('retry-after')).toBe('1');
  expect(Date.now() - startedAt).toBeLessThan(2_000); // not the full five-second wait
  expect(mocks.spawn).toHaveBeenCalledTimes(1);

  // A retry inside the window, by authorization or playlist poll, opens nothing.
  const retry = await fetch(`${base}/authorize`);
  expect(retry.status).toBe(503);
  expect(retry.headers.get('retry-after')).toBe('1');
  const poll = await fetch(`${base}/index.m3u8`);
  expect(poll.status).toBe(503);
  expect(poll.headers.get('retry-after')).toBe('1');
  expect(mocks.spawn).toHaveBeenCalledTimes(1);

  // After the window, one more attempt; a second rejection backs off further.
  await new Promise(resolve => setTimeout(resolve, 1_050));
  const second = await fetch(`${base}/authorize`);
  expect(second.status).toBe(503);
  expect(second.headers.get('retry-after')).toBe('2');
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
}, 15_000);

it('resets the backoff once the channel publishes', async () => {
  expect((await fetch(`${base}/authorize`)).status).toBe(503);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  expect((await fetch(`${base}/authorize`)).headers.get('retry-after')).toBe('2');
  await new Promise(resolve => setTimeout(resolve, 2_050));

  // The current channel reconnects outside its cooldown, and plays.
  source = 'playable';
  expect((await fetch(`${base}/authorize`)).status).toBe(200);
  expect(mocks.spawn).toHaveBeenCalledTimes(3);

  // A later rejection starts over at the first step.
  await buffer.releaseAll();
  source = 'rejected';
  const again = await fetch(`${base}/authorize`);
  expect(again.status).toBe(503);
  expect(again.headers.get('retry-after')).toBe('1');
  expect(mocks.spawn).toHaveBeenCalledTimes(4);
}, 15_000);

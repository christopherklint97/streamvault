import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn,
}));
import { createLiveBuffer } from './live-buffer.js';

type Worker = EventEmitter & { exitCode: number | null; signalCode: null; kill: () => boolean };
let root: string;
let buffer: ReturnType<typeof createLiveBuffer>;
const workers: Worker[] = [];
beforeEach(async () => {
  workers.length = 0;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const worker: Worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
    workers.push(worker);
    return worker;
  });
  root = await mkdtemp(path.join(tmpdir(), 'sv-live-switch-'));
  buffer = createLiveBuffer({ root, pollMs: 10, retryMs: 10 });
});
afterEach(async () => {
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

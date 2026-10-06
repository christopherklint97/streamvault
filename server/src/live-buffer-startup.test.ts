import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { createLiveBuffer } from './live-buffer.js';
let root: string;
let started: number;
let buffer: ReturnType<typeof createLiveBuffer>;
let worker: EventEmitter & { kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: string | null };
const reasons: string[] = [];
const unsafe = vi.fn((reason: string) => { reasons.push(reason); });
const inspected = vi.fn(async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(100_000);
  reasons.length = 0; inspected.mockClear(); unsafe.mockClear();
  root = await mkdtemp(path.join(tmpdir(), 'sv-live-startup-'));
  worker = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { queueMicrotask(() => { worker.exitCode = 0; worker.emit('close', 0); }); return true; }) });
  mocks.spawn.mockReset(); mocks.spawn.mockReturnValue(worker);
  buffer = createLiveBuffer({ root, packetAware: true, pollMs: 10, stallMs: 15_000,
    maxUnpublishedMs: 45_000, idleMs: 120_000, unsafeMarkerStat: inspected, onUnsafe: unsafe });
  await buffer.playlist('channel-a', 'http://127.0.0.1:1/api/stream/channel-a');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  started = Date.now();
  inspected.mockClear();
});
afterEach(async () => { await buffer.stop(); await rm(root, { recursive: true, force: true }); vi.useRealTimers(); });
it('does not poison a cold worker before its first source byte but still bounds first publication', async () => {
  vi.setSystemTime(started + 16_000);
  await vi.waitFor(() => { expect(reasons).toEqual([]); expect(inspected.mock.calls.length).toBeGreaterThanOrEqual(4); });
  expect(buffer.activeCount).toBe(1);
  expect(worker.kill).not.toHaveBeenCalled();
  expect(reasons).toEqual([]);
  vi.setSystemTime(started + 44_000);
  inspected.mockClear();
  await vi.waitFor(() => { expect(reasons).toEqual([]); expect(inspected.mock.calls.length).toBeGreaterThanOrEqual(4); });
  expect(buffer.activeCount).toBe(1);
  vi.setSystemTime(started + 46_000);
  await vi.waitFor(() => expect(buffer.activeCount).toBe(0));
  expect(reasons).toEqual(['no_new_segments']);
  expect(unsafe).toHaveBeenCalledExactlyOnceWith('no_new_segments', 'channel-a');
  expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
  expect(await buffer.playlist('channel-a', 'http://127.0.0.1:1/api/stream/channel-a')).toBeNull();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
it('still retires a published timeline if its progress marker is missing', async () => {
  const [channel] = await readdir(root);
  const [stage] = (await readdir(path.join(root, channel))).filter(name => name.startsWith('ingest-'));
  const directory = path.join(root, channel, stage);
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x1f, 0xff, 0x10]);
  await writeFile(path.join(directory, '0.ts'), packet);
  await writeFile(path.join(directory, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\n0.ts\n');
  await vi.waitFor(async () => expect(await buffer.playlist('channel-a', 'http://127.0.0.1:1/api/stream/channel-a')).toContain('segment/'));
  vi.setSystemTime(Date.now() + 16_000);
  await vi.waitFor(() => expect(buffer.activeCount).toBe(0));
  expect(reasons).toEqual(['source_stall']);
  expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
});

it('still retires a silent source after bytes started even before its first segment', async () => {
  const [channel] = await readdir(root);
  const [stage] = (await readdir(path.join(root, channel))).filter(name => name.startsWith('ingest-'));
  const marker = path.join(root, channel, stage, '.source-progress');
  await writeFile(marker, ''); await utimes(marker, new Date(started), new Date(started));
  vi.setSystemTime(started + 16_000);
  await vi.waitFor(() => expect(buffer.activeCount).toBe(0));
  expect(reasons).toEqual(['source_stall']);
});

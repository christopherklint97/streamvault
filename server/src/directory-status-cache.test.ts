// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createDirectoryStatusCache } from './directory-status-cache.js';

it('serves the last real directory snapshot immediately while a cold-disk refresh is pending', async () => {
  let now = 0;
  let release!: (value: { count: number }) => void;
  const read = vi.fn().mockResolvedValueOnce({ count: 238661 }).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const cache = createDirectoryStatusCache(read, () => 'catalog-a', { now: () => now, maxAgeMs: 30_000 });
  expect(await cache.get()).toEqual({ count: 238661 });
  now = 31_000;
  expect(await cache.get()).toEqual({ count: 238661 });
  expect(await cache.get()).toEqual({ count: 238661 });
  expect(read).toHaveBeenCalledTimes(2);
  release({ count: 238662 });
  await Promise.resolve(); await Promise.resolve();
  expect(await cache.get()).toEqual({ count: 238662 });
});

it('does not serve a previous provider snapshot after its generation changes', async () => {
  let catalog = 'a';
  const read = vi.fn().mockResolvedValueOnce({ count: 5 }).mockResolvedValueOnce({ count: 2 });
  const cache = createDirectoryStatusCache(read, () => catalog);
  await cache.get(); catalog = 'b';
  expect(await cache.get()).toEqual({ count: 2 });
  expect(read).toHaveBeenCalledTimes(2);
});

it('cannot publish a delayed old-provider refresh over a new-provider snapshot', async () => {
  let catalog = 'a'; let now = 0;
  let release!: (value: { count: number }) => void;
  const read = vi.fn().mockResolvedValueOnce({ count: 5 })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce({ count: 2 });
  const cache = createDirectoryStatusCache(read, () => catalog, { now: () => now, maxAgeMs: 1000 });
  await cache.get(); now = 2000;
  expect(await cache.get()).toEqual({ count: 5 });
  catalog = 'b';
  expect(await cache.get()).toEqual({ count: 2 });
  release({ count: 999 });
  await new Promise(resolve => setImmediate(resolve));
  expect(await cache.get()).toEqual({ count: 2 });
});

it('coalesces concurrent cold startup requests without inventing empty directory counts', async () => {
  let release!: (value: { count: number }) => void;
  const read = vi.fn(() => new Promise<{ count: number }>(resolve => { release = resolve; }));
  const cache = createDirectoryStatusCache(read, () => 'a');
  const first = cache.get(); const second = cache.get();
  expect(read).toHaveBeenCalledOnce();
  release({ count: 17 });
  expect(await first).toEqual({ count: 17 });
  expect(await second).toEqual({ count: 17 });
});

it('retains a real snapshot after refresh failure, but propagates a cold failure', async () => {
  let now = 0;
  const warn = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ count: 10 }).mockRejectedValueOnce(new Error('refresh failed'));
  const cache = createDirectoryStatusCache(read, () => 'a', { now: () => now, maxAgeMs: 1000, onError: warn });
  await expect(cache.get()).rejects.toThrow('read failed');
  expect(await cache.get()).toEqual({ count: 10 });
  now = 2000;
  expect(await cache.get()).toEqual({ count: 10 });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
});

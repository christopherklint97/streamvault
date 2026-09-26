// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDiskUsageCache, measureDiskUsage } from './recording-disk-usage.js';

describe('recording disk usage', () => {
  it('measures nested artifacts without blocking on synchronous stat calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-usage-'));
    try {
      fs.mkdirSync(path.join(root, 'child'));
      fs.writeFileSync(path.join(root, 'child', 'master.ts'), '12345');
      fs.writeFileSync(path.join(root, 'derivative.mp4'), '123');
      expect(await measureDiskUsage(root)).toBe(8);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('returns immediately while a disk read is pending and coalesces refreshes', async () => {
    let finish!: (size: number) => void;
    const load = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    let now = 100;
    const cache = createDiskUsageCache(load, () => now, 1000);
    expect(cache.get()).toBe(0);
    expect(cache.get()).toBe(0);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    finish(987);
    await vi.waitFor(() => expect(cache.get()).toBe(987));
    expect(load).toHaveBeenCalledTimes(1);
    now = 1200;
    expect(cache.get()).toBe(987);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    finish(1000);
    await vi.waitFor(() => expect(cache.get()).toBe(1000));
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DBProgram } from './db.js';
import { createOnDemandEpg } from './on-demand-epg.js';

const config = { server: 'http://provider.invalid', username: 'user', password: 'redacted' };
const current = (): DBProgram => ({ channel_id: 'live_1', title: 'SportsCenter', description: '', start_time: Date.now() - 1000, stop_time: Date.now() + 3600_000, category: '', last_seen: Date.now() });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('on-demand EPG', () => {
  it('returns cached rows without awaiting a stalled provider and coalesces repeat requests', async () => {
    const upstream = deferred<DBProgram[]>();
    const fetch = vi.fn(() => upstream.promise);
    let cached: DBProgram[] = [];
    const read = vi.fn(() => cached);
    const save = vi.fn((programs: DBProgram[]) => { cached = programs; });
    const epg = createOnDemandEpg({ read, fetch, save, getConfig: () => config, warn: vi.fn() });
    const from = Date.now() - 3600_000;
    const to = Date.now() + 3600_000;

    expect(epg.get(['live_1'], from, to)).toEqual([]);
    expect(epg.get(['live_1'], from, to)).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(config, [1], 'live_', 30);
    expect(save).not.toHaveBeenCalled();
    const airing = current();
    upstream.resolve([airing]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(epg.get(['live_1'], from, to)).toEqual([airing]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses bounded ten-channel waves while a hundred-channel provider is stalled', async () => {
    const firstWave = deferred<DBProgram[]>();
    const fetch = vi.fn().mockImplementationOnce(() => firstWave.promise).mockResolvedValue([]);
    const epg = createOnDemandEpg({ read: () => [], fetch, save: vi.fn(), getConfig: () => config, warn: vi.fn() });
    const now = Date.now();
    const ids = Array.from({ length: 100 }, (_, i) => `live_${i + 1}`);

    expect(epg.get(ids, now - 1000, now + 1000)).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0][1]).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(epg.get(ids, now - 1000, now + 1000)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    firstWave.resolve([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(10));
    expect(fetch.mock.calls.every(call => call[1].length <= 10)).toBe(true);
  });

  it('prioritizes an active channel over queued list refreshes', async () => {
    const firstWave = deferred<DBProgram[]>();
    const fetch = vi.fn().mockImplementationOnce(() => firstWave.promise).mockResolvedValue([]);
    const epg = createOnDemandEpg({ read: () => [], fetch, save: vi.fn(), getConfig: () => config, warn: vi.fn() });
    const now = Date.now();
    epg.get(Array.from({ length: 100 }, (_, i) => `live_${i + 1}`), now - 1000, now + 1000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    epg.get(['live_100'], now - 1000, now + 1000);
    firstWave.resolve([]);
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetch.mock.calls[1][1][0]).toBe(100);
  });

  it('refreshes a recently cached airing when its provider timestamp reveals the timezone error', async () => {
    const stale = {
      ...current(),
      raw_metadata: JSON.stringify({ start_timestamp: Math.floor(Date.now() / 1000) + 7200 }),
    };
    const corrected = { ...stale, start_time: stale.start_time + 7200_000 };
    const fetch = vi.fn(async () => [corrected]);
    const save = vi.fn();
    const epg = createOnDemandEpg({ read: () => [stale], fetch, save, getConfig: () => config, warn: vi.fn() });
    const now = Date.now();
    expect(epg.get(['live_1'], now - 1000, now + 3600_000)).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(config, [1], 'live_', 30));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith([corrected]));
  });

  it('does not fetch fresh or past cached guide and ignores non-live channel IDs', async () => {
    const fetch = vi.fn(async () => [] as DBProgram[]);
    const airing = current();
    const epg = createOnDemandEpg({ read: () => [airing], fetch, save: vi.fn(), getConfig: () => config, warn: vi.fn() });
    const now = Date.now();
    expect(epg.get(['live_1', 'recording_42', 'live_not_numeric'], now - 1000, now + 1000)).toEqual([airing]);
    expect(epg.get(['live_2'], now - 7200_000, now - 3600_000)).toEqual([airing]);
    await new Promise(resolve => setImmediate(resolve));
    expect(fetch).not.toHaveBeenCalled();
  });
});

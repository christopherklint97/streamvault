import { afterEach, expect, it, vi } from 'vitest';
import { fetchBatchEpg } from './epg-batch';
import { rotateBackendRequestScope, setStoredApiToken, StaleBackendRequestError } from '../services/api';

afterEach(() => { vi.restoreAllMocks(); setStoredApiToken(''); });

it('bounds bulk guide reads to two concurrent chunks and deduplicates channel IDs', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    requests.push(String(input)); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
    return new Response(JSON.stringify({ programs: {} }), { status: 200 });
  });
  const ids = Array.from({ length: 420 }, (_, index) => `live_${index}`);
  const result = fetchBatchEpg([...ids, ...ids]);
  await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2));
  expect(maximum).toBe(2);
  while (requests.length < 5 || active) {
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await result;
  expect(requests).toHaveLength(5);
  expect(maximum).toBe(2);
});

it('rejects an obsolete backend batch instead of returning its guide', async () => {
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = fetchBatchEpg(['live_a']);
  const rejected = expect(result).rejects.toBeInstanceOf(StaleBackendRequestError);
  rotateBackendRequestScope();
  release(new Response(JSON.stringify({ programs: { live_a: [{ title: 'Old guide' }] } }), { status: 200 }));
  await rejected;
});

it('cancels a replaced viewport read and does not schedule remaining chunks', async () => {
  const controller = new AbortController();
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, options) => {
    signals.push(options?.signal);
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))));
  });
  const pending = fetchBatchEpg(Array.from({ length: 320 }, (_, index) => `live_${index}`), undefined, undefined, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(signals.every(signal => signal?.aborted)).toBe(true);
});

it('bounds a stalled guide read instead of holding its refresh forever', async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const pending = fetchBatchEpg(['live_a']);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ApiTimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  } finally { vi.useRealTimers(); }
});

it('uses configured API authorization for protected guide requests', async () => {
  setStoredApiToken('synthetic-epg-fixture');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ programs: {} }), { status: 200 }));
  await fetchBatchEpg(['live_a']);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-streamvault-token')).toBe('synthetic-epg-fixture');
});

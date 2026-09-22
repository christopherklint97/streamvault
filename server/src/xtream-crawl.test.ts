// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCategoryStreams, fetchEpgForStreams, fetchXtreamStreamsByCategory } from './xtream.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Xtream live catalog metadata', () => {
  it('preserves provider EPG availability on live channels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        num: 1,
        name: 'With guide',
        stream_type: 'live',
        stream_id: 11,
        stream_icon: '',
        epg_channel_id: 'guide.11',
        category_id: '7',
      },
      {
        num: 2,
        name: 'Without guide',
        stream_type: 'live',
        stream_id: 12,
        stream_icon: '',
        epg_channel_id: '',
        category_id: '7',
      },
    ]), { status: 200 })));

    const channels = await fetchXtreamStreamsByCategory(
      { server: 'https://provider.example', username: 'user', password: 'pass' },
      'live_7',
      'News',
    );

    expect(channels.map(({ id, epg_channel_id }) => ({ id, epg_channel_id }))).toEqual([
      { id: 'live_11', epg_channel_id: 'guide.11' },
      { id: 'live_12', epg_channel_id: '' },
    ]);
  });
});

describe('Xtream catalog crawl cancellation', () => {
  it('aborts the active category request before publishing its channels', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('[]', { status: 200 })), 100);
        requestSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(requestSignal?.reason);
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onCategoryDone = vi.fn();

    const crawl = fetchAllCategoryStreams(
      { server: 'https://provider.example', username: 'user', password: 'pass' },
      [{ id: 'live_1', name: 'News' }],
      onCategoryDone,
      1,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(crawl).resolves.toBe(0);
    expect(requestSignal?.aborted).toBe(true);
    expect(onCategoryDone).not.toHaveBeenCalled();
  });
});

describe('Xtream EPG crawl cancellation', () => {
  it('aborts the active upstream batch and does not publish its programs', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({
          epg_listings: [{
            id: 'event-1', epg_id: 'guide-1', channel_id: 'guide-1',
            title: 'Show', description: '',
            start: '2026-09-22T08:00:00Z', end: '2026-09-22T09:00:00Z',
          }],
        }), { status: 200 })), 100);
        requestSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(requestSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onBatchDone = vi.fn();

    const crawl = fetchEpgForStreams(
      { server: 'https://provider.invalid', username: 'user', password: 'pass' },
      [1],
      onBatchDone,
      controller.signal,
      1,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(crawl).resolves.toBe(0);
    expect(requestSignal?.aborted).toBe(true);
    expect(onBatchDone).not.toHaveBeenCalled();
  });
});

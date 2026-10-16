// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setConfig: vi.fn(),
  matchRules: vi.fn(),
  fetchAllCategoryStreams: vi.fn(async () => 1),
  fetchEpgForStreams: vi.fn(),
}));

vi.mock('./db.js', () => ({
  default: { prepare: () => ({ all: () => [{ id: 'live_1' }] }) },
  saveChannels: vi.fn(),
  savePrograms: vi.fn(),
  saveCategories: vi.fn(),
  getConfig: (key: string, fallback = '') => ({
    input_mode: 'xtream',
    xtream_server: 'https://provider.invalid',
    xtream_username: 'user',
    xtream_password: 'pass',
  }[key] ?? fallback),
  setConfig: mocks.setConfig,
  getChannelCount: () => 1,
  getProgramCount: () => 1,
  getCategoryCount: () => 1,
  getCategories: () => [],
  getContentTypeCounts: () => ({}),
  saveChannelsForCategory: vi.fn(),
  markCategoryFetched: vi.fn(),
  saveProgramsForChannels: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./recording-scheduler.js', () => ({ matchRules: mocks.matchRules }));

vi.mock('./xtream.js', () => ({
  fetchXtreamCategories: vi.fn(async () => [{
    id: 'live_1', name: 'Live', content_type: 'livetv', stream_count: 1, fetched_at: 0,
  }]),
  fetchAllCategoryStreams: mocks.fetchAllCategoryStreams,
  fetchEpgForStreams: mocks.fetchEpgForStreams,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A fetch whose body emits `parts` after `delays`, erroring when the request signal aborts. */
function stubSlowFetch(parts: string[], delayMs: number): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
      pull(controller) {
        return new Promise<void>(resolve => {
          setTimeout(() => {
            if (index < parts.length) controller.enqueue(new TextEncoder().encode(parts[index++]));
            else controller.close();
            resolve();
          }, index < parts.length ? delayMs : 0);
        });
      },
    });
    return new Response(body);
  }));
}

describe('manual source download', () => {
  it('lets a slow but progressing body run past the connect timeout', async () => {
    vi.useFakeTimers();
    stubSlowFetch(['<tv>', '<x/>', '</tv>'], 45_000);
    const { fetchText } = await import('./sync.js');
    const text = fetchText('https://epg.invalid/guide.xml', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(150_000);
    await expect(text).resolves.toBe('<tv><x/></tv>');
  });

  it('fails a body that stalls longer than the idle timeout', async () => {
    vi.useFakeTimers();
    stubSlowFetch(['<tv>'], 90_000);
    const { fetchText } = await import('./sync.js');
    const text = fetchText('https://epg.invalid/guide.xml', new AbortController().signal);
    const failure = expect(text).rejects.toThrow('Download stalled for 60s');
    await vi.advanceTimersByTimeAsync(61_000);
    await failure;
  });
});

describe('manual sync cancellation', () => {
  it('reports syncing until the cancelled run unwinds, then allows a new sync', async () => {
    vi.useFakeTimers();
    const xtream = await import('./xtream.js');
    vi.mocked(xtream.fetchXtreamCategories).mockImplementationOnce(async (_config, signal) => {
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted');
    });
    const { cancelSync, getStatus, sync } = await import('./sync.js');

    const running = sync();
    await vi.waitFor(() => expect(xtream.fetchXtreamCategories).toHaveBeenCalledOnce());
    cancelSync();
    expect(getStatus()).toMatchObject({ isSyncing: true, message: 'Cancelling sync...' });
    await running;
    expect(getStatus()).toMatchObject({ isSyncing: false, phase: 'idle', message: 'Sync cancelled' });

    await sync();
    expect(xtream.fetchXtreamCategories).toHaveBeenCalledTimes(2);
    expect(getStatus()).toMatchObject({ isSyncing: false, phase: 'done' });
  });
});

describe('catalog crawl', () => {
  it('uses an off-thread status snapshot instead of synchronous database reads', async () => {
    const { getStatus } = await import('./sync.js');
    expect(getStatus({
      channelCount: 23, categoryCount: 5, lastSyncTime: 123, lastCrawlTime: 456,
      contentTypeCounts: { livetv: 4, movies: 1 }, crawlConfigured: true,
    })).toMatchObject({
      channelCount: 23, categoryCount: 5, lastSyncTime: 123, lastCrawlTime: 456,
      contentTypeCounts: { livetv: 4, movies: 1 }, crawlAvailable: true,
    });
  });

  it('indexes all categories without scanning every channel for EPG', async () => {
    const { startCrawl } = await import('./sync.js');
    await startCrawl();

    expect(mocks.fetchAllCategoryStreams).toHaveBeenCalledOnce();
    expect(mocks.fetchEpgForStreams).not.toHaveBeenCalled();
    expect(mocks.setConfig).toHaveBeenCalledWith('last_crawl_time', expect.any(String));
  });

  it('does not publish completion after a catalog crawl is cancelled', async () => {
    vi.useFakeTimers();
    mocks.fetchAllCategoryStreams.mockImplementation(async (_config, _cats, _onBatch, _concurrency, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    });
    const { cancelCrawl, getStatus, startCrawl } = await import('./sync.js');

    const crawl = startCrawl();
    await vi.waitFor(() => expect(mocks.fetchAllCategoryStreams).toHaveBeenCalledOnce());
    cancelCrawl();
    expect(mocks.setConfig).toHaveBeenCalledWith('catalog_generation', expect.any(String));
    expect(getStatus()).toMatchObject({
      isCrawling: true,
      crawlProgress: 'Cancelling crawl...',
    });
    await crawl;

    expect(getStatus()).toMatchObject({
      isCrawling: false,
      crawlProgress: 'Crawl cancelled',
    });
    expect(mocks.setConfig).not.toHaveBeenCalledWith('last_crawl_time', expect.any(String));
    expect(mocks.matchRules).not.toHaveBeenCalled();
  });
});

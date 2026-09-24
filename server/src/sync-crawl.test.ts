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
  vi.clearAllMocks();
});

describe('catalog crawl', () => {
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

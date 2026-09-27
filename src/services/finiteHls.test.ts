import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFiniteHls } from './finiteHls';

const { instance, isSupported } = vi.hoisted(() => ({
  instance: { attachMedia: vi.fn(), loadSource: vi.fn(), destroy: vi.fn(), on: vi.fn() },
  isSupported: vi.fn(() => true),
}));
vi.mock('hls.js', () => ({ default: Object.assign(class MockHls {
  constructor() { return instance; }
}, { isSupported, Events: { ERROR: 'hlsError' } }) }));

describe('finite HLS playback', () => {
  beforeEach(() => { vi.clearAllMocks(); isSupported.mockReturnValue(true); });
  it('attaches HLS.js in MSE browsers and destroys it when playback stops', async () => {
    const video = document.createElement('video');
    const cleanup = await attachFiniteHls(video, '/vod/index.m3u8', vi.fn());
    expect(instance.attachMedia).toHaveBeenCalledWith(video);
    expect(instance.loadSource).toHaveBeenCalledWith('/vod/index.m3u8');
    cleanup();
    expect(instance.destroy).toHaveBeenCalledOnce();
  });
  it('uses native HLS where MSE is unavailable', async () => {
    isSupported.mockReturnValue(false);
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('maybe');
    const cleanup = await attachFiniteHls(video, '/vod/index.m3u8', vi.fn());
    expect(video.src).toContain('/vod/index.m3u8');
    expect(instance.attachMedia).not.toHaveBeenCalled();
    cleanup();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('fails clearly when neither native HLS nor MSE works', async () => {
    isSupported.mockReturnValue(false);
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    await expect(attachFiniteHls(video, '/vod/index.m3u8', vi.fn()))
      .rejects.toThrow(/not supported/i);
  });
  it('reports a fatal transport error and releases the HLS.js instance', async () => {
    const video = document.createElement('video');
    const onFatal = vi.fn();
    await attachFiniteHls(video, '/vod/index.m3u8', onFatal);
    const handler = instance.on.mock.calls.find(([event]) => event === 'hlsError')?.[1] as
      ((event: string, data: { fatal: boolean; details: string }) => void) | undefined;
    expect(handler).toBeDefined();
    handler?.('hlsError', { fatal: true, details: 'networkError' });
    expect(onFatal).toHaveBeenCalledWith('networkError');
  });
});

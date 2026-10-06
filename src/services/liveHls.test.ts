import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachLiveHls } from './liveHls';

const hlsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    attachMedia = vi.fn();
    loadSource = vi.fn();
    destroy = vi.fn();
    on = vi.fn();
    constructor() { hlsMock.instances.push(this); }
  },
}));

describe('shared live HLS playback', () => {
  afterEach(() => { hlsMock.instances.length = 0; vi.restoreAllMocks(); });

  it('uses Hls.js on Chromium even when native HLS is advertised', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36');
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('maybe');
    const dispose = await attachLiveHls(video, '/api/live/live_future/index.m3u8', vi.fn());
    expect(hlsMock.instances).toHaveLength(1);
    expect(hlsMock.instances[0].attachMedia).toHaveBeenCalledWith(video);
    expect(video.src).toBe('');
    dispose();
  });

  it('keeps iPhone/native playback attached to one rolling playlist across source EOF', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('maybe');
    const dispose = await attachLiveHls(video, '/api/live/live_future/index.m3u8', vi.fn());
    expect(video.src).toContain('/api/live/live_future/index.m3u8');
    expect(hlsMock.instances).toHaveLength(0);
    dispose();
    expect(video.src).toBe('');
  });

  it('uses one Hls.js instance for the rolling feed on MSE browsers', async () => {
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    const dispose = await attachLiveHls(video, '/api/live/live_future/index.m3u8', vi.fn());
    expect(hlsMock.instances).toHaveLength(1);
    const hls = hlsMock.instances[0];
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    expect(hls.loadSource).toHaveBeenCalledWith('/api/live/live_future/index.m3u8');
    dispose();
    expect(hls.destroy).toHaveBeenCalledOnce();
  });

  it('retains native HLS as the fallback when MSE is unavailable', async () => {
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('maybe');
    const module = await import('hls.js');
    vi.spyOn(module.default, 'isSupported').mockReturnValue(false);
    const dispose = await attachLiveHls(video, '/api/live/live_future/index.m3u8', vi.fn());
    expect(video.src).toContain('/api/live/live_future/index.m3u8');
    expect(hlsMock.instances).toHaveLength(0);
    dispose();
  });

  it('never attaches an old HLS player after a delayed import and channel switch', async () => {
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    let current = true;
    let release!: (module: typeof import('hls.js')) => void;
    const load = () => new Promise<typeof import('hls.js')>(resolve => { release = resolve; });
    const attaching = attachLiveHls(video, '/api/live/old/index.m3u8', vi.fn(), () => current, load);
    current = false;
    release(await import('hls.js'));
    await expect(attaching).rejects.toThrow();
    expect(hlsMock.instances).toHaveLength(0);
    expect(video.src).toBe('');
  });
});

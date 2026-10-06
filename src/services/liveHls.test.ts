import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachLiveHls } from './liveHls';

const hlsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    config: Record<string, unknown>;
    attachMedia: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: 'error', BUFFER_APPENDED: 'bufferAppended' };
    attachMedia = vi.fn();
    loadSource = vi.fn();
    destroy = vi.fn();
    on = vi.fn();
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) { this.config = config; hlsMock.instances.push(this); }
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

  it('keeps 24-second headroom independent of long-GOP TARGETDURATION without catch-up seeks', async () => {
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    const dispose = await attachLiveHls(video, '/api/live/test/index.m3u8', vi.fn());
    expect(hlsMock.instances[0].config.liveSyncDuration).toBe(24);
    expect(hlsMock.instances[0].config.liveMaxLatencyDuration).toBe(Infinity);
    expect(hlsMock.instances[0].config).not.toHaveProperty('liveSyncDurationCount');
    expect(hlsMock.instances[0].config).not.toHaveProperty('liveMaxLatencyDurationCount');
    dispose();
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

  it.each(['superseded', 'disposed', 'fatal'])(
    'stops forwarding BUFFER_APPENDED after the player is %s', async reason => {
      const video = document.createElement('video');
      vi.spyOn(video, 'canPlayType').mockReturnValue('');
      let current = true;
      const appended = vi.fn();
      const dispose = await attachLiveHls(video, '/api/live/test/index.m3u8', vi.fn(),
        () => current, undefined, appended);
      const hls = hlsMock.instances[0];
      const onAppend = hls.on.mock.calls.find(([event]) => event === 'bufferAppended')![1];
      onAppend();
      expect(appended).toHaveBeenCalledOnce();
      if (reason === 'superseded') current = false;
      else if (reason === 'disposed') dispose();
      else hls.on.mock.calls.find(([event]) => event === 'error')![1]('error', { fatal: true, details: 'test' });
      onAppend();
      expect(appended).toHaveBeenCalledOnce();
      dispose();
      expect(hls.destroy).toHaveBeenCalledOnce();
    },
  );

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

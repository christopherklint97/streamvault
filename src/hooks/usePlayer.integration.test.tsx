import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seekRecordingPlayback, stopActivePlayback, usePlayer } from './usePlayer';
import { commercialSkipSession } from '../services/commercialSkipSession';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { saveWatchProgress } from '../services/channel-service';
import { getRecordingVodStatus } from '../services/recordingPlayback';

const mpegtsMock = vi.hoisted(() => ({
  createPlayer: vi.fn(() => ({
    on: vi.fn(), attachMediaElement: vi.fn(), load: vi.fn(), unload: vi.fn(), detachMediaElement: vi.fn(), destroy: vi.fn(),
  })),
}));
const hlsMock = vi.hoisted(() => ({
  isSupported: vi.fn(() => false),
  instances: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('hls.js', () => ({ default: class {
  static isSupported = hlsMock.isSupported;
  static Events = { ERROR: 'error' };
  on = vi.fn();
  attachMedia = vi.fn();
  loadSource = vi.fn();
  destroy = vi.fn();
  constructor() { hlsMock.instances.push(this); }
} }));

vi.mock('mpegts.js', () => ({ default: { isSupported: () => true, createPlayer: mpegtsMock.createPlayer, Events: {
  ERROR: 'error', LOADING_COMPLETE: 'complete', MEDIA_INFO: 'info', STATISTICS_INFO: 'stats',
} } }));
vi.mock('../services/recordingPlayback', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/recordingPlayback')>(),
  getRecordingPlaybackUrl: vi.fn(async () => '/api/recordings/r1/stream?ticket=fresh'),
  getRecordingVodStatus: vi.fn(async () => 'missing'),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Harness = forwardRef<ReturnType<typeof usePlayer>>(function Harness(_props, ref) {
  const player = usePlayer();
  useImperativeHandle(ref, () => player, [player]);
  return null;
});

describe('usePlayer manual seek integration', () => {
  let root: Root;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let hookRef: RefObject<ReturnType<typeof usePlayer> | null>;

  beforeEach(async () => {
    localStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    }));
    useAppStore.setState({ showToast: false, toastMessage: '' });
    hookRef = createRef<ReturnType<typeof usePlayer>>();
    video = document.createElement('video');
    video.id = 'av-player';
    document.body.append(video);
    usePlayerStore.setState({
      currentChannel: {
        id: 'recording_r1', name: 'Recording', url: '/ticketed', logo: '', group: '', region: '',
        contentType: 'movies', recordingId: 'r1', duration: 120,
      },
      status: 'playing',
      errorMessage: '',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness ref={hookRef} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    commercialSkipSession.reset();
    delete (globalThis as typeof globalThis & { webapis?: WebApis }).webapis;
    video.remove();
    container.remove();
    vi.restoreAllMocks();
    mpegtsMock.createPlayer.mockClear();
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReset().mockReturnValue(false);
    vi.mocked(getRecordingVodStatus).mockReset().mockResolvedValue('missing');
    vi.useRealTimers();
    localStorage.clear();
    useAppStore.setState({ showToast: false, toastMessage: '' });
  });

  it('demuxes a finite TS-only recording instead of assigning MPEG-TS to native video', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'recording_r1', name: 'Recording', url: '/ticketed', logo: '', group: '', region: '',
      contentType: 'movies', recordingId: 'r1', recordingTransport: 'mpegts',
      recordingSize: 123456, duration: 120,
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mpegts', isLive: false, url: '/ticketed', filesize: 123456, duration: 120000 }),
      expect.any(Object),
    ));
    expect(video.src).not.toContain('/ticketed');
    await act(async () => hookRef.current?.stop());
  });

  it('keeps playing buffered live media after upstream EOF until the buffer tail', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'live_71984', name: 'NFL Redzone', url: '/api/stream/live_71984',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    Object.defineProperty(video, 'buffered', { configurable: true, value: {
      length: 1, start: () => 0, end: () => 90,
    } });
    video.currentTime = 40;
    try {
      await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
      await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1));
      const player = mpegtsMock.createPlayer.mock.results[0].value;
      const complete = (player.on.mock.calls as unknown as Array<[string, () => void]>)
        .find(([event]) => event === 'complete')?.[1];
      expect(complete).toBeDefined();
      usePlayerStore.setState({ status: 'playing' });

      await act(async () => { complete?.(); await Promise.resolve(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().status).toBe('playing');
      await act(async () => video.dispatchEvent(new Event('waiting')));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
      expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1);

      video.currentTime = 88;
      await act(async () => video.dispatchEvent(new Event('timeupdate')));
      await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => hookRef.current?.stop());
    }
  });

  it('waits for final MSE append before treating live EOF as an empty buffer', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'live_71984', name: 'NFL Redzone', url: '/api/stream/live_71984',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    let bufferEnd = 0;
    Object.defineProperty(video, 'buffered', { configurable: true, get: () => ({
      length: bufferEnd ? 1 : 0, start: () => 0, end: () => bufferEnd,
    }) });
    video.currentTime = 40;
    try {
      await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
      await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1));
      const player = mpegtsMock.createPlayer.mock.results[0].value;
      const complete = (player.on.mock.calls as unknown as Array<[string, () => void]>)
        .find(([event]) => event === 'complete')?.[1];
      expect(complete).toBeDefined();
      usePlayerStore.setState({ status: 'playing' });
      await act(async () => { complete?.(); await Promise.resolve(); });
      bufferEnd = 90; // final SourceBuffer update becomes visible after LOADING_COMPLETE
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
      expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().status).not.toBe('loading');
    } finally {
      await act(async () => hookRef.current?.stop());
    }
  });

  it('retains live EOF recovery while paused and reconnects on resume', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'live_71984', name: 'NFL Redzone', url: '/api/stream/live_71984',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    let paused = false;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; });
    vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; });
    Object.defineProperty(video, 'buffered', { configurable: true, value: {
      length: 1, start: () => 0, end: () => 41,
    } });
    video.currentTime = 40;
    try {
      await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
      await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1));
      const player = mpegtsMock.createPlayer.mock.results[0].value;
      const complete = (player.on.mock.calls as unknown as Array<[string, () => void]>)
        .find(([event]) => event === 'complete')?.[1];
      expect(complete).toBeDefined();
      await act(async () => video.dispatchEvent(new Event('loadeddata')));
      await act(async () => video.dispatchEvent(new Event('canplay')));
      await act(async () => hookRef.current?.togglePlay());
      expect(paused).toBe(true);
      await act(async () => { complete?.(); await Promise.resolve(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(1);
      await act(async () => { hookRef.current?.togglePlay(); video.dispatchEvent(new Event('play')); });
      await vi.waitFor(() => expect(mpegtsMock.createPlayer).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => hookRef.current?.stop());
    }
  });

  it('stops cold live authorization retries when the viewer stops playback', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(globalThis.fetch).mockImplementation(async url => String(url).endsWith('/authorize')
      ? new Response(JSON.stringify({ error: 'Warming up' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } })
      : new Response('{}', { status: 404 }));
    usePlayerStore.setState({ currentChannel: {
      id: 'live_future', name: 'ESPN live', url: '/test-only-source', logo: '', group: '', region: '', contentType: 'livetv',
    } });
    await act(async () => { hookRef.current?.play(); await vi.advanceTimersByTimeAsync(0); });
    const before = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/authorize')).length;
    expect(before).toBe(1);
    await act(async () => hookRef.current?.stop());
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/authorize'))).toHaveLength(before);
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
  });

  it('opens the same buffered live HLS feed on Samsung instead of a per-view TS response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/authorize')
      ? new Response(JSON.stringify({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 404 }));
    usePlayerStore.setState({ currentChannel: {
      id: 'live_future', name: 'Live channel', url: '/api/stream/live_future',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    const avplay = {
      close: vi.fn(), open: vi.fn(), setDisplayRect: vi.fn(), setBufferingParam: vi.fn(),
      setListener: vi.fn(), prepareAsync: vi.fn(), stop: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis: WebApis }).webapis = { avplay } as unknown as WebApis;
    await act(async () => hookRef.current?.play());
    await vi.waitFor(() => expect(avplay.open).toHaveBeenCalledWith('http://localhost:3000/api/live/live_future/index.m3u8?ticket=synthetic'));
    await act(async () => hookRef.current?.stop());
  });

  it('uses native buffered live HLS on iPhone instead of a per-view mpegts player', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/authorize')
      ? new Response(JSON.stringify({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 404 }));
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    vi.spyOn(video, 'canPlayType').mockReturnValue('maybe');
    usePlayerStore.setState({ currentChannel: {
      id: 'live_future', name: 'Live channel', url: '/api/stream/live_future',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    await vi.waitFor(() => expect(video.src).toBe('http://localhost:3000/api/live/live_future/index.m3u8?ticket=synthetic'));
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
    await act(async () => hookRef.current?.stop());
  });

  it('keeps one HLS.js live player on desktop while the source reconnects behind the playlist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/authorize')
      ? new Response(JSON.stringify({ playlistUrl: '/api/live/live_future/index.m3u8?ticket=synthetic' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 404 }));
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    hlsMock.isSupported.mockReturnValue(true);
    usePlayerStore.setState({ currentChannel: {
      id: 'live_future', name: 'Live channel', url: '/api/stream/live_future',
      logo: '', group: '', region: '', contentType: 'livetv',
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    await vi.waitFor(() => expect(hlsMock.instances).toHaveLength(1));
    expect(hlsMock.instances[0].loadSource).toHaveBeenCalledWith('/api/live/live_future/index.m3u8?ticket=synthetic');
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
    await act(async () => hookRef.current?.stop());
    expect(hlsMock.instances[0].destroy).toHaveBeenCalledOnce();
  });

  it('sends a TS-only iPhone recording through native HLS, not a whole-file MSE demux', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    usePlayerStore.setState({ currentChannel: {
      id: 'recording_r1', name: 'Recording', url: '/api/recordings/r1/stream?ticket=abc',
      logo: '', group: '', region: '', contentType: 'movies', recordingId: 'r1',
      recordingTransport: 'mpegts', duration: 120, recordingSize: 123456,
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    expect(video.src).toContain('/api/recordings/r1/hls/index.m3u8?ticket=abc');
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
    await act(async () => hookRef.current?.seek(42));
    await vi.waitFor(() => expect(video.src).toContain('ticket=fresh&start=42'));
  });

  it('opens a prepared recording as finite VOD at the saved absolute position', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    saveWatchProgress('recording_r1', 42, 120, 'movies');
    usePlayerStore.setState({ currentChannel: {
      id: 'recording_r1', name: 'Recording', url: '/api/recordings/r1/stream?ticket=abc',
      logo: '', group: '', region: '', contentType: 'movies', recordingId: 'r1',
      recordingTransport: 'mpegts', recordingVodReady: true, duration: 120,
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    expect(video.src).toContain('/api/recordings/r1/hls/index.m3u8?ticket=abc');
    expect(video.src).not.toContain('start=42');
    expect(video.dataset.streamOffset).toBe('0');
  });

  it('switches rolling iPhone playback to a finite seekable rendition at the same absolute time', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    usePlayerStore.setState({ currentChannel: {
      id: 'recording_r1', name: 'Recording', url: '/api/recordings/r1/stream?ticket=abc',
      logo: '', group: '', region: '', contentType: 'movies', recordingId: 'r1',
      recordingTransport: 'mpegts', recordingVodReady: false, duration: 120,
    } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    video.currentTime = 48;
    vi.mocked(getRecordingVodStatus).mockResolvedValue('ready');
    await vi.waitFor(() => expect(video.src).toContain('ticket=fresh'), { timeout: 18_000 });
    expect(video.src).not.toContain('start=48');
    expect(video.dataset.streamOffset).toBe('0');
  }, 20_000);

  it('seeks to the absolute timeline once the native VOD rendition is available', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    usePlayerStore.setState({ currentChannel: {
      id: 'recording_r1', name: 'Recording', url: '/api/recordings/r1/stream?ticket=old',
      logo: '', group: '', region: '', contentType: 'movies', recordingId: 'r1',
      recordingTransport: 'mpegts', recordingVodReady: true, duration: 120,
    } });
    vi.mocked(getRecordingVodStatus).mockResolvedValue('ready');
    await act(async () => hookRef.current?.seek(70));
    await vi.waitFor(() => expect(video.src).toContain('ticket=fresh'));
    expect(video.src).not.toContain('start=70');
    expect(video.dataset.streamOffset).toBe('0');
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(70);
  });

  it('still closes AVPlay when stop throws during backend cleanup', () => {
    const close = vi.fn();
    (globalThis as typeof globalThis & { webapis: WebApis }).webapis = {
      avplay: {
        stop: vi.fn(() => { throw new Error('stop failed'); }),
        close,
      },
    } as unknown as WebApis;

    expect(() => stopActivePlayback()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().status).toBe('idle');
  });

  it('invalidates a pending automatic skip as soon as scrubbing begins and before every manual seek', async () => {
    const noteManualSeek = vi.spyOn(commercialSkipSession, 'noteManualSeek');

    await act(async () => hookRef.current?.beginManualSeek());
    expect(noteManualSeek).toHaveBeenCalledTimes(1);

    await act(async () => hookRef.current?.seek(42));
    expect(noteManualSeek).toHaveBeenCalledTimes(2);
    expect(video.currentTime).toBe(42);
  });

  it('keeps a manual HTML5 seek ahead of an aborted automatic seek and its retries', async () => {
    vi.useFakeTimers();
    const generation = commercialSkipSession.beginPlayback({
      recordingId: 'r1',
      duration: 120,
      enabled: true,
      segments: [{
        id: 'ad', startSeconds: 10, endSeconds: 20, source: 'detector', confidence: 1, state: 'accepted',
      }],
      seek: seekRecordingPlayback,
    });
    commercialSkipSession.tick(10, generation);
    expect(video.currentTime).toBe(20);

    await act(async () => hookRef.current?.seek(42));
    video.dispatchEvent(new Event('seeked'));
    await vi.runAllTimersAsync();

    expect(video.currentTime).toBe(42);
    expect(commercialSkipSession.getSnapshot().undo).toBeNull();
  });

  it('reapplies a manual AVPlay seek after a stale automatic success callback', async () => {
    vi.useFakeTimers();
    let staleSuccess: (() => void) | undefined;
    const seekTo = vi.fn((positionMs: number, success?: () => void) => {
      if (positionMs === 20_000 && !staleSuccess) staleSuccess = success;
    });
    (globalThis as typeof globalThis & { webapis: WebApis }).webapis = {
      avplay: { seekTo },
    } as unknown as WebApis;
    const generation = commercialSkipSession.beginPlayback({
      recordingId: 'r1',
      duration: 120,
      enabled: true,
      segments: [{
        id: 'ad', startSeconds: 10, endSeconds: 20, source: 'detector', confidence: 1, state: 'accepted',
      }],
      seek: seekRecordingPlayback,
    });
    commercialSkipSession.tick(10, generation);
    expect(seekTo).toHaveBeenCalledWith(20_000, expect.any(Function), expect.any(Function));

    await act(async () => hookRef.current?.seek(42));
    staleSuccess?.();
    await vi.runAllTimersAsync();

    expect(seekTo.mock.calls.map(([position]) => position)).toEqual([20_000, 42_000, 42_000]);
    expect(commercialSkipSession.getSnapshot().undo).toBeNull();
  });

  it('clamps a stale HTML5 bookmark and starts from zero after bounded resume retries fail', async () => {
    vi.useFakeTimers();
    localStorage.setItem('streamvault_watch_progress', JSON.stringify({
      recording_r1: {
        channelId: 'recording_r1', position: 999, duration: 1_000, updatedAt: 1,
        contentType: 'movies', completed: false,
      },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const commercialTick = vi.spyOn(commercialSkipSession, 'tick');
    const playVideo = vi.spyOn(video, 'play').mockResolvedValue();
    let mediaTime = 0;
    const assignedTimes: number[] = [];
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => mediaTime,
      set: (value: number) => {
        mediaTime = value;
        assignedTimes.push(value);
      },
    });

    await act(async () => hookRef.current?.play());
    await act(async () => {
      video.oncanplay?.(new Event('canplay'));
      video.onloadeddata?.(new Event('loadeddata'));
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(playVideo).not.toHaveBeenCalled();
    expect(commercialTick).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(assignedTimes.slice(0, 3)).toEqual([120, 120, 120]);
    expect(mediaTime).toBe(0);
    expect(playVideo).not.toHaveBeenCalled();
    expect(commercialTick).not.toHaveBeenCalled();

    await act(async () => {
      video.dispatchEvent(new Event('seeked'));
      await Promise.resolve();
    });

    expect(playVideo).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState()).toMatchObject({ status: 'playing', errorMessage: '' });
    expect(useAppStore.getState()).toMatchObject({
      showToast: true,
      toastMessage: 'Could not resume playback; playing from the beginning',
    });
    expect(commercialTick).toHaveBeenCalledTimes(1);

    await act(async () => hookRef.current?.stop());
  });

  it('starts AVPlay from zero when a clamped bookmark is unseekable', async () => {
    vi.useFakeTimers();
    localStorage.setItem('streamvault_watch_progress', JSON.stringify({
      recording_r1: {
        channelId: 'recording_r1', position: 999, duration: 1_000, updatedAt: 1,
        contentType: 'movies', completed: false,
      },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const commercialTick = vi.spyOn(commercialSkipSession, 'tick');
    let completeFallback: (() => void) | undefined;
    const seekTo = vi.fn((positionMs: number, success?: () => void, failure?: (error: Error) => void) => {
      if (positionMs === 0) completeFallback = success;
      else failure?.(new Error('media is not seekable'));
    });
    const avplay = {
      close: vi.fn(),
      open: vi.fn(),
      setDisplayRect: vi.fn(),
      setBufferingParam: vi.fn(),
      setListener: vi.fn(),
      prepareAsync: vi.fn((success?: () => void) => success?.()),
      getDuration: vi.fn(() => 120_000),
      getCurrentTime: vi.fn(() => 0),
      seekTo,
      play: vi.fn(),
      stop: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis: WebApis }).webapis = {
      avplay,
    } as unknown as WebApis;

    await act(async () => {
      hookRef.current?.play();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(avplay.play).not.toHaveBeenCalled();
    expect(commercialTick).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(seekTo.mock.calls.map(([position]) => position)).toEqual([
      120_000, 120_000, 120_000, 0,
    ]);
    expect(avplay.play).not.toHaveBeenCalled();
    expect(commercialTick).not.toHaveBeenCalled();

    await act(async () => {
      completeFallback?.();
      await Promise.resolve();
    });

    expect(avplay.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState()).toMatchObject({ status: 'playing', errorMessage: '' });
    expect(useAppStore.getState()).toMatchObject({
      showToast: true,
      toastMessage: 'Could not resume playback; playing from the beginning',
    });
    expect(commercialTick).toHaveBeenCalledTimes(1);

    await act(async () => hookRef.current?.stop());
  });

  it('does not rewind a finite archive to an old bookmark when AVPlay buffers', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    usePlayerStore.setState({ currentChannel: {
      id: 'archive_live_44115', name: 'TV4 archive', url: '/api/archive/snapshots/t/index.m3u8',
      logo: '', group: '', region: '', contentType: 'movies', dvrHls: true,
      duration: 600, initialSeekSeconds: 20,
    } });
    let positionMs = 20_000;
    const seekTo = vi.fn((targetMs: number, success?: () => void) => { positionMs = targetMs; success?.(); });
    const listeners: Array<{ oncurrentplaytime: (ms: number) => void; onbufferingstart: () => void;
      onbufferingcomplete: () => void }> = [];
    const avplay = {
      close: vi.fn(), open: vi.fn(), setDisplayRect: vi.fn(), setBufferingParam: vi.fn(),
      setListener: vi.fn((listener: typeof listeners[number]) => { listeners.push(listener); }),
      prepareAsync: vi.fn((success?: () => void) => success?.()),
      getDuration: vi.fn(() => 600_000), getCurrentTime: vi.fn(() => positionMs),
      seekTo, play: vi.fn(), stop: vi.fn(),
    };
    (globalThis as typeof globalThis & { webapis: WebApis }).webapis = { avplay } as unknown as WebApis;
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    expect(avplay.open).toHaveBeenCalledTimes(1);
    positionMs = 42_500;
    await act(async () => { listeners[0].oncurrentplaytime(positionMs); });
    saveWatchProgress('archive_live_44115', 35, 600, 'movies'); // stale ten-second checkpoint
    await act(async () => { listeners[0].onbufferingstart(); await vi.advanceTimersByTimeAsync(8_000); });
    expect(avplay.open).toHaveBeenCalledTimes(2);
    expect(seekTo).toHaveBeenLastCalledWith(42_500, expect.any(Function), expect.any(Function));
    positionMs = 0; // AVPlay can report zero while buffering even after prior progress.
    await act(async () => { listeners[1].oncurrentplaytime(43_000); });
    await act(async () => { listeners[1].onbufferingstart(); await vi.advanceTimersByTimeAsync(8_000); });
    expect(avplay.open).toHaveBeenCalledTimes(3);
    expect(seekTo).toHaveBeenLastCalledWith(43_000, expect.any(Function), expect.any(Function));
    await act(async () => { listeners[2].onbufferingstart(); await vi.advanceTimersByTimeAsync(7_000);
      listeners[2].onbufferingcomplete(); await vi.advanceTimersByTimeAsync(2_000); });
    expect(avplay.open).toHaveBeenCalledTimes(3);
    await act(async () => hookRef.current?.stop());
  });

  it.each(['completion', 'error'] as const)(
    'defers a Samsung live %s during retry cooldown instead of ending playback', async event => {
      vi.useFakeTimers({ now: Date.now() + (event === 'completion' ? 60_000 : 120_000) });
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => String(url).endsWith('/authorize')
        ? Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
        : new Promise<Response>(() => {}));
      await act(async () => { usePlayerStore.setState({ currentChannel: {
        id: 'live_future', name: 'Live channel', url: '/api/stream/live_future',
        logo: '', group: '', region: '', contentType: 'livetv',
      } }); });
      const listeners: Array<{ onstreamcompleted: () => void; onerror: () => void;
        onbufferingstart: () => void; onbufferingcomplete: () => void;
        oncurrentplaytime: (ms: number) => void }> = [];
      const prepareFailures: Array<() => void> = [];
      const avplay = {
        close: vi.fn(), open: vi.fn(), setDisplayRect: vi.fn(), setBufferingParam: vi.fn(),
        setListener: vi.fn((listener: typeof listeners[number]) => { listeners.push(listener); }),
        prepareAsync: vi.fn((success?: () => void, failure?: () => void) => {
          prepareFailures.push(() => failure?.()); success?.();
        }),
        getDuration: vi.fn(() => 0), getCurrentTime: vi.fn(() => 0),
        play: vi.fn(), stop: vi.fn(),
      };
      (globalThis as typeof globalThis & { webapis: WebApis }).webapis = { avplay } as unknown as WebApis;
      await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      await act(async () => { listeners[0].onstreamcompleted(); await Promise.resolve(); });
      expect(avplay.open).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (event === 'completion') listeners[1].onstreamcompleted();
        else listeners[1].onerror();
        listeners[1].onstreamcompleted(); // duplicate terminal callback must not queue another retry
        await Promise.resolve();
      });
      expect(avplay.open).toHaveBeenCalledTimes(2);
      expect(usePlayerStore.getState().status).toBe('loading');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
      expect(avplay.open).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(avplay.open).toHaveBeenCalledTimes(3);
      if (event === 'completion') {
        await act(async () => { listeners[2].onstreamcompleted(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
        expect(avplay.open).toHaveBeenCalledTimes(3);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(avplay.open).toHaveBeenCalledTimes(4);
        await act(async () => { listeners[3].onstreamcompleted(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
        expect(avplay.open).toHaveBeenCalledTimes(4);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(avplay.open).toHaveBeenCalledTimes(5);
        for (const delay of [20_000, 30_000, 30_000]) {
          const before = avplay.open.mock.calls.length;
          await act(async () => { listeners[before - 1].onstreamcompleted(); });
          await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
          expect(avplay.open).toHaveBeenCalledTimes(before);
          await act(async () => { await vi.advanceTimersByTimeAsync(1); });
          expect(avplay.open).toHaveBeenCalledTimes(before + 1);
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
        const healthyIndex = avplay.open.mock.calls.length - 1;
        await act(async () => { listeners[healthyIndex].oncurrentplaytime(12_000); });
        await act(async () => { listeners[healthyIndex].onstreamcompleted(); });
        expect(avplay.open).toHaveBeenCalledTimes(healthyIndex + 2); // healthy playback resets backoff
      }
      const activeIndex = avplay.open.mock.calls.length - 1;
      await act(async () => { listeners[activeIndex].onstreamcompleted(); hookRef.current?.stop(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(avplay.open).toHaveBeenCalledTimes(activeIndex + 1);
      await act(async () => {
        listeners[activeIndex].onerror(); listeners[activeIndex].onstreamcompleted();
        listeners[activeIndex].onbufferingstart(); listeners[activeIndex].onbufferingcomplete();
        prepareFailures[activeIndex]();
      });
      expect(usePlayerStore.getState().status).toBe('idle');
    },
  );
});

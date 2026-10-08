import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from './usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import type { getAuthorizedLiveHlsUrl } from '../services/livePlayback';
import { ApiError, rotateBackendRequestScope } from '../services/api';
import { clientLogger } from '../utils/logger';

const mocks = vi.hoisted(() => {
  // The module-level recovery singleton captures Date.now in its constructor.
  // Install one fake clock before importing it, not a fresh clock per test.
  vi.useFakeTimers();
  return {
    hlsSupported: vi.fn(() => true),
    mpegtsPlayer: { on: vi.fn(), destroy: vi.fn(), load: vi.fn(),
      attachMediaElement: vi.fn((video: HTMLVideoElement) => { video.src = 'blob:legacy-ts-test'; }) },
    authorize: vi.fn<typeof getAuthorizedLiveHlsUrl>(async () => '/api/live/live_test/index.m3u8?ticket=test-only'),
    instances: [] as Array<{ on: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
  };
});
vi.mock('../utils/logger', () => ({ clientLogger: {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
vi.mock('../services/livePlayback', () => ({ getAuthorizedLiveHlsUrl: mocks.authorize }));
vi.mock('mpegts.js', () => ({ default: {
  isSupported: () => true,
  createPlayer: () => mocks.mpegtsPlayer,
  Events: { ERROR: 'error', LOADING_COMPLETE: 'complete', MEDIA_INFO: 'info', STATISTICS_INFO: 'stats' },
} }));
vi.mock('hls.js', () => ({ default: class {
  static isSupported = mocks.hlsSupported;
  static Events = { ERROR: 'error', BUFFER_APPENDED: 'bufferAppended' };
  on = vi.fn();
  destroy = vi.fn();
  attachMedia(video: HTMLVideoElement) { video.src = 'blob:live-test'; }
  loadSource = vi.fn();
  constructor() { mocks.instances.push(this); }
} }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const Harness = forwardRef<ReturnType<typeof usePlayer>>(function Harness(_props, ref) {
  const player = usePlayer();
  useImperativeHandle(ref, () => player, [player]);
  return null;
});

describe('signed live HLS startup and recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let hookRef: RefObject<ReturnType<typeof usePlayer> | null>;
  let ranges: Array<[number, number]>;

  beforeEach(async () => {
    vi.setSystemTime(0);
    vi.clearAllMocks();
    mocks.instances.length = 0;
    mocks.hlsSupported.mockReturnValue(true);
    mocks.authorize.mockReset();
    mocks.authorize.mockImplementation(async (_base, _channel, _origin, options) => options?.delivery === 'compatible'
      ? '/api/live-compatible/live_test/index.m3u8?ticket=compatible-test'
      : '/api/live/live_test/index.m3u8?ticket=test-only');
    localStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    video = document.createElement('video');
    video.id = 'av-player';
    document.body.append(video);
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    vi.spyOn(video, 'play').mockResolvedValue();
    vi.spyOn(video, 'pause');
    ranges = [[40, 47]];
    Object.defineProperty(video, 'buffered', { configurable: true, get: () => ({
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    }) });
    usePlayerStore.setState({ currentChannel: {
      id: 'live_test', name: 'Test live', url: '/unused', logo: '', group: '', region: '', contentType: 'livetv',
    }, status: 'idle', errorMessage: '', audioOnly: false });
    hookRef = createRef<ReturnType<typeof usePlayer>>();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness ref={hookRef} />));
  });

  afterEach(async () => {
    await act(async () => hookRef.current?.stop());
    await act(async () => root.unmount());
    video.remove();
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  afterAll(() => vi.useRealTimers());

  async function ready() {
    await act(async () => hookRef.current?.play());
    video.currentTime = 40;
    await act(async () => {
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
    });
  }

  it('does not start signed live MSE with only seven buffered seconds', async () => {
    await ready();
    expect(video.src).toBe('blob:live-test');
    expect(video.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe('loading');
  });

  it('starts once when BUFFER_APPENDED grows the continuous lead to twelve seconds', async () => {
    await ready();
    ranges = [[40, 52]];
    const appended = mocks.instances[0].on.mock.calls.find(([event]) => event === 'bufferAppended')?.[1];
    await act(async () => appended?.());
    expect(video.play).toHaveBeenCalledOnce();
    const pauses = vi.mocked(video.pause).mock.calls.length;
    ranges = [[40, 42]];
    await act(async () => {
      appended?.();
      video.dispatchEvent(new Event('canplay'));
      video.dispatchEvent(new Event('progress'));
    });
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledTimes(pauses);
  });

  it.each(['loadeddata', 'progress', 'canplaythrough', 'seeked'])(
    'wakes the startup gate on native %s events', async event => {
      await ready();
      ranges = [[40, 52]];
      await act(async () => video.dispatchEvent(new Event(event)));
      expect(video.play).toHaveBeenCalledOnce();
    },
  );

  it('does not sum disconnected buffered ranges or accept a gap at the playhead', async () => {
    ranges = [[40, 47], [48, 65]];
    await ready();
    expect(video.play).not.toHaveBeenCalled();
    ranges = [[40.1, 65]];
    await act(async () => video.dispatchEvent(new Event('canplay')));
    expect(video.play).not.toHaveBeenCalled();
  });

  it('resumes prepared native HLS synchronously from a tap after Brave blocks autoplay', async () => {
    vi.spyOn(video, 'load').mockImplementation(() => {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    let inGesture = false;
    vi.mocked(video.play).mockImplementation(() => inGesture
      ? Promise.resolve()
      : Promise.reject(new DOMException('User gesture required', 'NotAllowedError')));
    await act(async () => hookRef.current?.play());
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    expect(usePlayerStore.getState().errorMessage).toBe('');
    const preparedSrc = video.src;
    const loads = vi.mocked(video.load).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    act(() => {
      inGesture = true;
      hookRef.current?.retry();
      inGesture = false;
      expect(video.play).toHaveBeenCalledTimes(2);
    });
    await act(async () => {});
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(video.src).toBe(preparedSrc);
    expect(video.load).toHaveBeenCalledTimes(loads);
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.instances).toHaveLength(0);
  });

  async function blockedNativePlayback() {
    vi.spyOn(video, 'load').mockImplementation(() => {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    // Mirrors a WebKit exception originating inside Brave's play() wrapper.
    vi.mocked(video.play).mockRejectedValue(Object.assign(
      new DOMException('User gesture required', 'NotAllowedError'),
      { line: 62, column: 28, sourceURL: 'user-script:3' },
    ));
    await act(async () => hookRef.current?.play());
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
  }

  it('keeps repeated permission denials local and ignores readiness/buffering noise', async () => {
    await blockedNativePlayback();
    await act(async () => hookRef.current?.retry());
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    await act(async () => {
      for (const event of ['loadeddata', 'canplay', 'waiting', 'stalled', 'playing']) video.dispatchEvent(new Event(event));
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(clientLogger.error).not.toHaveBeenCalled();
  });

  it('shows an actionable error when native HLS ends after autoplay denial', async () => {
    await blockedNativePlayback();
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    await act(async () => video.dispatchEvent(new Event('ended')));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/retry/i);
    await act(async () => {
      video.dispatchEvent(new Event('waiting'));
      video.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(usePlayerStore.getState().status).toBe('error');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    await act(async () => hookRef.current?.retry());
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(video.play).toHaveBeenCalledOnce();
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it.each(['awaiting tap', 'pending tap'])(
    'shows an actionable error when HLS is destroyed after denial with %s', async phase => {
      vi.mocked(video.play).mockRejectedValue(new DOMException('User gesture required', 'NotAllowedError'));
      ranges = [[40, 55]];
      await ready();
      expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
      let resolvePlay!: () => void;
      if (phase === 'pending tap') {
        vi.mocked(video.play).mockImplementationOnce(() => new Promise(resolve => { resolvePlay = resolve; }));
        await act(async () => hookRef.current?.retry());
        expect(usePlayerStore.getState().status).toBe('loading');
      }
      const hls = mocks.instances[0];
      const fatal = hls.on.mock.calls.find(([event]) => event === 'error')![1];
      await act(async () => fatal('error', { fatal: true, details: 'bufferAppendError' }));
      expect(hls.destroy).toHaveBeenCalledOnce();
      expect(usePlayerStore.getState().status).toBe('error');
      expect(usePlayerStore.getState().errorMessage).toMatch(/retry/i);
      await act(async () => {
        resolvePlay?.();
        video.dispatchEvent(new Event('waiting'));
        video.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(65_000);
      });
      expect(usePlayerStore.getState().status).toBe('error');
      expect(mocks.authorize).toHaveBeenCalledOnce();
      const plays = vi.mocked(video.play).mock.calls.length;
      await act(async () => hookRef.current?.retry());
      expect(mocks.authorize).toHaveBeenCalledTimes(2);
      expect(mocks.instances).toHaveLength(2);
      expect(video.play).toHaveBeenCalledTimes(plays);
      vi.mocked(video.play).mockResolvedValue();
      await act(async () => {
        video.dispatchEvent(new Event('loadeddata'));
        video.dispatchEvent(new Event('canplay'));
      });
      expect(usePlayerStore.getState().status).toBe('playing');
    },
  );

  it.each(['transport error', 'media error', 'drained EOF'])(
    'invalidates a denied legacy TS transport on %s', async terminal => {
      mocks.hlsSupported.mockReturnValue(false);
      vi.mocked(video.play).mockRejectedValue(new DOMException('User gesture required', 'NotAllowedError'));
      await ready();
      expect(video.src).toBe('blob:legacy-ts-test');
      expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
      const onError = mocks.mpegtsPlayer.on.mock.calls.find(([event]) => event === 'error')![1];
      const onComplete = mocks.mpegtsPlayer.on.mock.calls.find(([event]) => event === 'complete')![1];
      if (terminal === 'drained EOF') {
        await act(async () => {
          onComplete();
          await vi.advanceTimersByTimeAsync(750);
        });
        // Transport completion alone can leave buffered media to resume.
        expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
      }
      await act(async () => {
        if (terminal === 'transport error') onError('NetworkError', 'EarlyEof', {});
        else video.dispatchEvent(new Event(terminal === 'media error' ? 'error' : 'ended'));
      });
      expect(usePlayerStore.getState().status).toBe('error');
      expect(usePlayerStore.getState().errorMessage).toMatch(/retry/i);
      await act(async () => {
        onError('NetworkError', 'EarlyEof', {});
        onComplete();
        video.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(65_000);
      });
      expect(usePlayerStore.getState().status).toBe('error');
      expect(mocks.authorize).toHaveBeenCalledOnce();
      expect(video.play).toHaveBeenCalledOnce();
      await act(async () => hookRef.current?.retry());
      expect(mocks.authorize).toHaveBeenCalledTimes(2);
      expect(video.play).toHaveBeenCalledOnce();
      vi.mocked(video.play).mockResolvedValue();
      await act(async () => {
        video.dispatchEvent(new Event('loadeddata'));
        video.dispatchEvent(new Event('canplay'));
      });
      expect(usePlayerStore.getState().status).toBe('playing');
    },
  );

  it.each(['native', 'HLS', 'legacy TS', 'unsigned TS'].flatMap(transport =>
    ['stop', 'channel', 'backend', 'replacement'].map(invalidation => [transport, invalidation]),
  ))('ignores obsolete %s terminal callbacks after %s invalidation', async (transport, invalidation) => {
    if (transport === 'native') await blockedNativePlayback();
    else {
      if (transport.endsWith('TS')) mocks.hlsSupported.mockReturnValue(false);
      if (transport === 'unsigned TS') mocks.authorize.mockResolvedValue(null);
      vi.mocked(video.play).mockRejectedValue(new DOMException('User gesture required', 'NotAllowedError'));
      ranges = [[40, 55]];
      await ready();
    }
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    const ended = video.onended!;
    const mediaError = video.onerror!;
    const fatal = mocks.instances[0]?.on.mock.calls.find(([event]) => event === 'error')?.[1];
    const tsError = mocks.mpegtsPlayer.on.mock.calls.find(([event]) => event === 'error')?.[1];
    await act(async () => {
      if (invalidation === 'stop') hookRef.current?.stop();
      if (invalidation === 'channel') usePlayerStore.setState({ currentChannel: {
        ...usePlayerStore.getState().currentChannel!, id: 'live_other',
      } });
      if (invalidation === 'backend') rotateBackendRequestScope();
      if (invalidation === 'replacement') hookRef.current?.play();
    });
    const state = usePlayerStore.getState().status;
    const authorizations = mocks.authorize.mock.calls.length;
    await act(async () => {
      if (transport === 'native') ended.call(video, new Event('ended'));
      if (transport === 'HLS') fatal('error', { fatal: true, details: 'bufferAppendError' });
      if (transport.endsWith('TS')) tsError('NetworkError', 'EarlyEof', {});
    });
    expect(usePlayerStore.getState().status).toBe(state);
    await act(async () => ended.call(video, new Event('ended')));
    expect(usePlayerStore.getState().status).toBe(state);
    await act(async () => mediaError.call(video, new Event('error')));
    expect(usePlayerStore.getState().status).toBe(state);
    expect(mocks.authorize).toHaveBeenCalledTimes(authorizations);
  });

  it('bounds a permission tap whose play promise never settles', async () => {
    await blockedNativePlayback();
    vi.mocked(video.play).mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => hookRef.current?.retry());
    expect(usePlayerStore.getState().status).toBe('loading');
    await act(async () => vi.advanceTimersByTimeAsync(30_250));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it('restores the bounded no-progress watchdog after a successful permission tap', async () => {
    await blockedNativePlayback();
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => hookRef.current?.retry());
    expect(usePlayerStore.getState().status).toBe('playing');
    await act(async () => vi.advanceTimersByTimeAsync(30_250));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/compatible.*retry/i);
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it('restores live recovery after the permission tap and proven media progress', async () => {
    await blockedNativePlayback();
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => hookRef.current?.togglePlay());
    video.currentTime = 1;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    await act(async () => vi.advanceTimersByTimeAsync(12_250));
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().status).toBe('loading');
  });

  it('retains the prepared resume continuation across hook remount', async () => {
    await blockedNativePlayback();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness ref={hookRef} />));
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => hookRef.current?.retry());
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'channel', 'backend', 'replacement'])(
    'ignores pending permission-play settlement after %s invalidation', async invalidation => {
      await blockedNativePlayback();
      let rejectPlay!: (error: unknown) => void;
      vi.mocked(video.play).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
      await act(async () => hookRef.current?.retry());
      // A second tap during the unresolved promise must not start another attempt.
      await act(async () => hookRef.current?.retry());
      expect(video.play).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (invalidation === 'stop') hookRef.current?.stop();
        if (invalidation === 'channel') usePlayerStore.setState({ currentChannel: {
          ...usePlayerStore.getState().currentChannel!, id: 'live_other',
        }, status: 'playing' });
        if (invalidation === 'backend') { rotateBackendRequestScope(); usePlayerStore.setState({ status: 'playing' }); }
        if (invalidation === 'replacement') hookRef.current?.play();
      });
      const state = usePlayerStore.getState().status;
      const authorizations = mocks.authorize.mock.calls.length;
      await act(async () => rejectPlay(new DOMException('Old permission denial', 'NotAllowedError')));
      expect(usePlayerStore.getState().status).toBe(state);
      expect(mocks.authorize).toHaveBeenCalledTimes(authorizations);
    },
  );

  it.each(['AbortError', 'NotSupportedError', 'Error'])(
    'does not disguise %s as an autoplay permission request', async name => {
      vi.mocked(video.play).mockRejectedValue(new DOMException('Synthetic media failure', name));
      ranges = [[40, 55]];
      await ready();
      expect(usePlayerStore.getState().status).toBe('error');
      expect(usePlayerStore.getState().errorMessage).toMatch(/could not start/i);
    },
  );

  it('starts native iPhone HLS from its first loaded frame without waiting for paused canplay', async () => {
    // happy-dom load() synthesizes canplay; real paused WebKit can stop at loadeddata.
    vi.spyOn(video, 'load').mockImplementation(() => {});
    let nativeSrc = '';
    Object.defineProperty(video, 'src', { configurable: true, get: () => nativeSrc, set: (url: string) => { nativeSrc = url; } });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    ranges = [];
    await act(async () => hookRef.current?.play());
    await act(async () => video.dispatchEvent(new Event('loadeddata')));
    expect(video.play).toHaveBeenCalledOnce();
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.instances).toHaveLength(0);
    // WebKit may emit canplay only after playback has been requested.
    await act(async () => video.dispatchEvent(new Event('canplay')));
    expect(video.play).toHaveBeenCalledOnce();
  });

  it.each(['iPhone', 'Safari'])(
    'starts native %s HLS normally without twelve seconds of lead', async platform => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform === 'iPhone'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1'
        : 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15');
      vi.mocked(video.canPlayType).mockReturnValue('maybe');
      ranges = [];
      await ready();
      expect(mocks.instances).toHaveLength(0);
      expect(video.play).toHaveBeenCalledOnce();
    },
  );

  it.each(['iPhone', 'Safari'])('requests compatible HLS immediately on %s without waiting for or racing primary', async platform => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform === 'iPhone'
      ? 'iPhone AppleWebKit/605.1.15 Safari/604.1' : 'Macintosh AppleWebKit/605.1.15 Safari/605.1.15');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    let resolveAuthorization!: (url: string) => void;
    mocks.authorize.mockImplementationOnce(() => new Promise(resolve => { resolveAuthorization = resolve; }));
    await act(async () => hookRef.current?.play());
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.authorize).toHaveBeenNthCalledWith(1, expect.any(String), 'live_test', window.location.origin,
      expect.objectContaining({ delivery: 'compatible', isCurrent: expect.any(Function) }));
    await act(async () => vi.advanceTimersByTimeAsync(49_000));
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(video.getAttribute('src')).toBeNull();
    await act(async () => resolveAuthorization('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test'));
    expect(new URL(video.src).pathname).toBe('/api/live-compatible/live_test/index.m3u8');
    expect(mocks.instances).toHaveLength(0);
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
  });

  it('logs credential-safe native authorization and only proven first-media latency', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockImplementationOnce(() => new Promise(resolve => setTimeout(() =>
      resolve('/api/live-compatible/live_test/index.m3u8?ticket=private-test-ticket'), 1200)));
    await act(async () => hookRef.current?.play());
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(clientLogger.info).toHaveBeenCalledWith(
      'Native live HLS authorize channelID=live_test delivery=compatible elapsedms=1200');
    await act(async () => {
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
      video.dispatchEvent(new Event('playing'));
      video.dispatchEvent(new Event('timeupdate'));
    });
    expect(vi.mocked(clientLogger.info).mock.calls.filter(([message]) => message.startsWith('Native live HLS first media'))).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    video.currentTime = 1;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    video.currentTime = 2;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    const diagnostics = vi.mocked(clientLogger.info).mock.calls.filter(([message]) => message.startsWith('Native live HLS'));
    expect(diagnostics).toEqual([
      ['Native live HLS authorize channelID=live_test delivery=compatible elapsedms=1200'],
      ['Native live HLS first media channelID=live_test delivery=compatible elapsedms=1500'],
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/ticket|https?:|\/api\/|Test live|unused/);
  });

  it.each(['iPhone', 'Safari'])('plays the first compatible signed native HLS authorization on %s', async platform => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform === 'iPhone'
      ? 'iPhone AppleWebKit/605.1.15 Safari/604.1' : 'Macintosh AppleWebKit/605.1.15 Safari/605.1.15');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValueOnce('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.any(String), 'live_test', window.location.origin,
      expect.objectContaining({ delivery: 'compatible', isCurrent: expect.any(Function) }));
    expect(new URL(video.src).pathname).toBe('/api/live-compatible/live_test/index.m3u8');
    expect(video.play).toHaveBeenCalledOnce();
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(mocks.instances).toHaveLength(0);
  });

  it('keeps explicit retry compatible after native media failure', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(usePlayerStore.getState().status).toBe('error');
    await act(async () => hookRef.current?.retry());
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.any(String), 'live_test', window.location.origin,
      expect.objectContaining({ delivery: 'compatible' }));
    expect(new URL(video.src).pathname).toBe('/api/live-compatible/live_test/index.m3u8');
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
  });

  it('selects compatible HLS again after remount without losing healthy background playback', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    const src = video.getAttribute('src');
    const pauses = vi.mocked(video.pause).mock.calls.length;
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness ref={hookRef} />));
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(video.getAttribute('src')).toBe(src);
    expect(video.pause).toHaveBeenCalledTimes(pauses);
    expect(mocks.authorize).toHaveBeenCalledOnce();
    await act(async () => hookRef.current?.retry());
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize.mock.calls.every(call => call[3]?.delivery === 'compatible')).toBe(true);
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
  });

  it.each(['zero timeupdate', 'no media events'])(
    'stops first compatible startup without verified media progress with %s', async startup => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
      vi.mocked(video.canPlayType).mockReturnValue('maybe');
      ranges = [];
      mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
      await act(async () => hookRef.current?.play());
      expect(mocks.authorize).toHaveBeenCalledOnce();
      expect(new URL(video.src).pathname).toBe('/api/live-compatible/live_test/index.m3u8');
      // Neither a zero-time clock event nor ready/play events prove media progress.
      video.currentTime = 0;
      if (startup === 'zero timeupdate') await act(async () => video.dispatchEvent(new Event('timeupdate')));
      await act(async () => vi.advanceTimersByTimeAsync(29_999));
      expect(usePlayerStore.getState().status).toBe('loading');
      await act(async () => vi.advanceTimersByTimeAsync(251));
      expect(usePlayerStore.getState().status).toBe('error');
      expect(usePlayerStore.getState().errorMessage).toMatch(/compatible.*connection.*retry/i);
      await act(async () => {
        video.dispatchEvent(new Event('error'));
        video.dispatchEvent(new Event('ended'));
        video.dispatchEvent(new Event('waiting'));
        video.dispatchEvent(new Event('stalled'));
        await vi.advanceTimersByTimeAsync(169_250);
      });
      expect(usePlayerStore.getState().status).toBe('error');
      expect(mocks.authorize).toHaveBeenCalledOnce();
      expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
      expect(mocks.instances).toHaveLength(0);
      // Explicit retry starts a fresh attempt and can still become healthy.
      await act(async () => hookRef.current?.retry());
      video.currentTime = 1;
      await act(async () => {
        video.dispatchEvent(new Event('loadeddata'));
        video.dispatchEvent(new Event('canplay'));
        video.dispatchEvent(new Event('timeupdate'));
      });
      expect(mocks.authorize).toHaveBeenCalledTimes(2);
      expect(mocks.authorize.mock.calls.every(call => call[3]?.delivery === 'compatible')).toBe(true);
      expect(usePlayerStore.getState().status).toBe('playing');
    },
  );

  it('does not treat compatible readiness or a resolved play promise as media progress', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    expect(usePlayerStore.getState().status).toBe('playing');
    await act(async () => vi.advanceTimersByTimeAsync(30_250));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/compatible.*retry/i);
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
  });

  it('recovers later interruptions after compatible native media genuinely advances', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    await act(async () => vi.advanceTimersByTimeAsync(12_250));
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.any(String), 'live_test', window.location.origin,
      expect.objectContaining({ delivery: 'compatible' }));
    expect(usePlayerStore.getState().status).toBe('loading');
    video.currentTime = 41;
    await act(async () => {
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(12_250);
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(3);
    expect(mocks.authorize.mock.calls.every(call => call[3]?.delivery === 'compatible')).toBe(true);
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(mocks.instances).toHaveLength(0);
  });

  it('retains playing status when a compatible recovery watchdog fires after backend invalidation', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    expect(usePlayerStore.getState().status).toBe('playing');
    const src = video.getAttribute('src');
    const pauses = vi.mocked(video.pause).mock.calls.length;
    await act(async () => rotateBackendRequestScope());
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(usePlayerStore.getState().errorMessage).toBe('');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledTimes(pauses);
    expect(video.getAttribute('src')).toBe(src);
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(mocks.instances).toHaveLength(0);
  });

  it('retains playing status when a compatible native media error fires after backend invalidation', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await ready();
    expect(usePlayerStore.getState().status).toBe('playing');
    const src = video.getAttribute('src');
    const pauses = vi.mocked(video.pause).mock.calls.length;
    await act(async () => rotateBackendRequestScope());
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(usePlayerStore.getState().errorMessage).toBe('');
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(usePlayerStore.getState().errorMessage).toBe('');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledTimes(pauses);
    expect(video.getAttribute('src')).toBe(src);
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(mocks.instances).toHaveLength(0);
  });

  it.each(['stop', 'channel switch', 'backend switch'])(
    'ignores the compatible first-frame watchdog after %s', async cancellation => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
      vi.mocked(video.canPlayType).mockReturnValue('maybe');
      mocks.authorize.mockResolvedValue('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
      await act(async () => hookRef.current?.play());
      await act(async () => {
        if (cancellation === 'stop') hookRef.current?.stop();
        else if (cancellation === 'channel switch') usePlayerStore.setState({ currentChannel: {
          ...usePlayerStore.getState().currentChannel!, id: 'live_next',
        } });
        else rotateBackendRequestScope();
      });
      const status = usePlayerStore.getState().status;
      await act(async () => vi.advanceTimersByTimeAsync(65_000));
      expect(usePlayerStore.getState().status).toBe(status);
      expect(mocks.authorize).toHaveBeenCalledOnce();
      expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    },
  );

  it.each(['attachment', 'media'])('never sends a native Apple client to raw TS when compatible HLS %s fails', async failure => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    if (failure === 'attachment') vi.spyOn(video, 'load').mockImplementation(() => {
      if (video.getAttribute('src')?.includes('/api/live-compatible/')) throw new Error('Native attachment failed');
    });
    mocks.authorize.mockResolvedValueOnce('/api/live-compatible/live_test/index.m3u8?ticket=compatible-test');
    await act(async () => hookRef.current?.play());
    if (failure === 'media') await act(async () => video.dispatchEvent(new Event('error')));
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/compatible.*retry/i);
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it.each([401, 403])('never retries or falls back to primary or raw TS after compatible auth %s', async status => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockRejectedValue(new ApiError(status, 'Synthetic rejection'));
    await act(async () => hookRef.current?.play());
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.authorize.mock.calls[0][3]?.delivery).toBe('compatible');
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe('error');
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it('shows a bounded actionable error when compatible authorization remains unavailable', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    mocks.authorize.mockImplementationOnce(() =>
      new Promise(resolve => setTimeout(() => resolve(null), 50_000)));
    await act(async () => hookRef.current?.play());
    expect(usePlayerStore.getState().status).toBe('loading');
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/compatible.*connection.*retry/i);
    await act(async () => {
      video.dispatchEvent(new Event('error'));
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
  });

  it.each(['stop', 'channel switch', 'backend switch', 'replacement play'])(
    'ignores a compatible authorization arriving after %s', async cancellation => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
      vi.mocked(video.canPlayType).mockReturnValue('maybe');
      let resolveCompatible!: (url: string) => void;
      mocks.authorize.mockImplementationOnce(() =>
        new Promise(resolve => { resolveCompatible = resolve; }));
      await act(async () => hookRef.current?.play());
      const isCurrent = mocks.authorize.mock.calls[0][3]!.isCurrent!;
      await act(async () => {
        if (cancellation === 'stop') hookRef.current?.stop();
        else if (cancellation === 'channel switch') usePlayerStore.setState({ currentChannel: {
          ...usePlayerStore.getState().currentChannel!, id: 'live_next',
        } });
        else if (cancellation === 'backend switch') rotateBackendRequestScope();
        else hookRef.current?.play();
      });
      expect(isCurrent()).toBe(false);
      const status = usePlayerStore.getState().status;
      const src = video.getAttribute('src');
      await act(async () => resolveCompatible('/api/live-compatible/live_test/index.m3u8?ticket=obsolete'));
      expect(video.getAttribute('src')).toBe(src);
      expect(usePlayerStore.getState().status).toBe(status);
      expect(mocks.mpegtsPlayer.load).not.toHaveBeenCalled();
    },
  );

  it('does not gate a legacy TS fallback even when live authorization succeeded', async () => {
    mocks.hlsSupported.mockReturnValue(false);
    await act(async () => {
      hookRef.current?.play();
      await vi.waitFor(() => expect(mocks.mpegtsPlayer.load).toHaveBeenCalled());
    });
    video.currentTime = 40;
    await act(async () => {
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
    });
    expect(video.src).toBe('blob:legacy-ts-test');
    expect(video.play).toHaveBeenCalledOnce();
  });

  it.each([
    ['audio', 'desktop'], ['finite DVR', 'desktop'], ['VOD', 'desktop'],
    ['audio', 'iPhone'], ['finite DVR', 'iPhone'], ['VOD', 'iPhone'],
  ])(
    'keeps %s startup unchanged on %s with less than twelve seconds buffered', async (kind, platform) => {
      if (platform === 'iPhone') {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
        vi.mocked(video.canPlayType).mockReturnValue('maybe');
      }
      if (kind === 'audio') usePlayerStore.setState({ audioOnly: true });
      else usePlayerStore.setState({ currentChannel: {
        ...usePlayerStore.getState().currentChannel!,
        id: 'test_finite', contentType: 'movies',
        ...(kind === 'finite DVR' ? { dvrHls: true } : {}),
      } });
      await ready();
      expect(video.play).toHaveBeenCalledOnce();
      expect(mocks.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 410])('shows an actionable error for rejected legacy live HTTP %s rather than retrying forever', async code => {
    mocks.authorize.mockResolvedValue(null as unknown as string);
    await act(async () => {
      hookRef.current?.play();
      await vi.waitFor(() => expect(mocks.mpegtsPlayer.load).toHaveBeenCalled());
    });
    const onError = mocks.mpegtsPlayer.on.mock.calls.find(([event]) => event === 'error')![1];
    await act(async () => onError('NetworkError', 'HttpStatusCodeInvalid', { code, msg: 'test rejection' }));
    expect(usePlayerStore.getState().status).toBe('error');
    expect(usePlayerStore.getState().errorMessage).toMatch(/live stream.*retry/i);
    expect(mocks.mpegtsPlayer.destroy).toHaveBeenCalled();
    await act(async () => {
      onError('NetworkError', 'HttpStatusCodeInvalid', { code: 503 });
      video.dispatchEvent(new Event('error'));
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(usePlayerStore.getState().status).toBe('error');
    expect(mocks.authorize).toHaveBeenCalledOnce();
    // A new explicit retry must still be able to attach and play normally.
    mocks.authorize.mockResolvedValue('/api/live/live_test/index.m3u8?ticket=retry');
    ranges = [[40, 60]];
    await ready();
    expect(video.play).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it('does not shorten first-frame acquisition after an initial zero-time timeupdate', async () => {
    await act(async () => hookRef.current?.play());
    video.currentTime = 0;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(24_000);
    });
    expect(mocks.authorize).toHaveBeenCalledOnce();
    video.currentTime = 1;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(12_250);
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
  });

  it.each(['stop', 'channel switch', 'new authorization', 'new authorization with queued retry'])(
    'cannot start from obsolete callbacks or recovery timers after %s', async cancellation => {
      await ready();
      // Real LiveStreamRecovery: media progress arms the twelve-second watchdog.
      await act(async () => video.dispatchEvent(new Event('timeupdate')));
      const appended = mocks.instances[0].on.mock.calls.find(([event]) => event === 'bufferAppended')?.[1];
      const canplay = video.oncanplay!;
      const progress = video.onprogress;
      let resolveAuthorization: ((url: string) => void) | undefined;
      if (cancellation === 'new authorization with queued retry') {
        await act(async () => video.dispatchEvent(new Event('ended')));
      }
      await act(async () => {
        if (cancellation === 'stop') hookRef.current?.stop();
        else if (cancellation === 'channel switch') usePlayerStore.setState({ currentChannel: {
          ...usePlayerStore.getState().currentChannel!, id: 'live_next',
        } });
        else {
          mocks.authorize.mockImplementationOnce(() => new Promise<string>(resolve => {
            resolveAuthorization = resolve;
          }));
          hookRef.current?.play();
        }
      });
      ranges = [[40, 60]];
      await act(async () => {
        appended?.();
        canplay.call(video, new Event('canplay'));
        progress?.call(video, new ProgressEvent('progress'));
        // Cross both watchdog + retry deadlines, still inside authorization's 50s budget.
        await vi.advanceTimersByTimeAsync(49_000);
      });
      expect(video.play).not.toHaveBeenCalled();
      if (resolveAuthorization) {
        expect(mocks.authorize).toHaveBeenCalledTimes(2);
        expect(mocks.instances).toHaveLength(1);
        expect(usePlayerStore.getState().status).toBe('loading');
        await act(async () => resolveAuthorization!('/api/live/live_test/index.m3u8?ticket=replacement'));
        expect(mocks.instances).toHaveLength(2);
        await act(async () => {
          video.dispatchEvent(new Event('loadeddata'));
          video.dispatchEvent(new Event('canplay'));
        });
        expect(video.play).toHaveBeenCalledOnce();
        expect(usePlayerStore.getState().status).toBe('playing');
        // The replacement still owns normal recovery after authorization completes.
        await act(async () => {
          video.dispatchEvent(new Event('timeupdate'));
          await vi.advanceTimersByTimeAsync(12_250);
        });
        expect(mocks.authorize).toHaveBeenCalledTimes(3);
        expect(mocks.instances).toHaveLength(3);
      }
    },
  );
});

import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from './usePlayer';
import { usePlayerStore } from '../stores/playerStore';

const mocks = vi.hoisted(() => {
  // The module-level recovery singleton captures Date.now in its constructor.
  // Install one fake clock before importing it, not a fresh clock per test.
  vi.useFakeTimers();
  return {
    hlsSupported: vi.fn(() => true),
    mpegtsPlayer: { on: vi.fn(), destroy: vi.fn(), load: vi.fn(),
      attachMediaElement: vi.fn((video: HTMLVideoElement) => { video.src = 'blob:legacy-ts-test'; }) },
    authorize: vi.fn(async () => '/api/live/live_test/index.m3u8?ticket=test-only'),
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

describe('signed live MSE startup lead', () => {
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
    mocks.authorize.mockResolvedValue('/api/live/live_test/index.m3u8?ticket=test-only');
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

  it.each(['audio', 'finite DVR', 'VOD'])(
    'keeps %s startup unchanged with less than twelve seconds buffered', async kind => {
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
        // Cross both watchdog + retry deadlines, still inside authorization's 25s budget.
        await vi.advanceTimersByTimeAsync(24_000);
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

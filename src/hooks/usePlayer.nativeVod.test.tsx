import { createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '../test/act';
import { stopActivePlayback, usePlayer } from './usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import { saveWatchProgress } from '../services/channel-service';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Harness = forwardRef<ReturnType<typeof usePlayer>>(function Harness(_props, ref) {
  const player = usePlayer();
  useImperativeHandle(ref, () => player, [player]);
  return null;
});

describe('native iPhone VOD startup', () => {
  let root: Root;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let hook: RefObject<ReturnType<typeof usePlayer> | null>;

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    video = document.createElement('video');
    video.id = 'av-player';
    document.body.append(video);
    // Model paused WebKit: load() need not emit loadeddata or canplay.
    vi.spyOn(video, 'load').mockImplementation(() => {});
    vi.spyOn(video, 'play').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    usePlayerStore.setState({
      currentChannel: {
        id: 'episode_1484136', name: 'MobLand', url: 'https://provider.invalid/episode.mkv',
        logo: '', group: '', region: '', contentType: 'series', duration: 3600,
      },
      status: 'idle', errorMessage: '',
    });
    hook = createRef<ReturnType<typeof usePlayer>>();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness ref={hook} />));
  });

  afterEach(async () => {
    await act(async () => { stopActivePlayback(); root.unmount(); });
    video.remove();
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('requests playback inside the original tap before Safari loads a frame, keeping the server resume offset', async () => {
    saveWatchProgress('episode_1484136', 131.437, 3600, 'series');
    await act(async () => {
      hook.current?.play();
      expect(video.play).toHaveBeenCalledOnce();
    });
    expect(video.src).toContain('/api/ios-hls-authorize/episode_1484136/index.m3u8?');
    expect(video.src).toContain('start=131.437');
    expect(video.dataset.streamOffset).toBe('131.437');
    expect(video.currentTime).toBe(0);
    await act(async () => {
      video.dispatchEvent(new Event('loadedmetadata'));
      video.dispatchEvent(new Event('loadeddata'));
      video.dispatchEvent(new Event('canplay'));
    });
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('ends metadata-only startup after thirty seconds and ignores a late play resolution', async () => {
    let resolvePlay!: () => void;
    vi.mocked(video.play).mockImplementation(() => new Promise(resolve => { resolvePlay = resolve; }));
    await act(async () => hook.current?.play());
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(usePlayerStore.getState().status).toBe('loading');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', errorMessage: expect.stringMatching(/tap to retry/i) });
    expect(video.hasAttribute('src')).toBe(false);
    await act(async () => { resolvePlay(); });
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('cancels the startup deadline when media starts playing', async () => {
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => hook.current?.play());
    await act(async () => video.dispatchEvent(new Event('playing')));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(video.hasAttribute('src')).toBe(true);
  });

  it('keeps an autoplay-denied stream ready for a synchronous permission tap with a new deadline', async () => {
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'));
    await act(async () => hook.current?.play());
    const preparedSource = video.src;
    const loads = vi.mocked(video.load).mock.calls.length;
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(usePlayerStore.getState().status).toBe('awaiting-gesture');
    await act(async () => {
      hook.current?.retry();
      expect(video.play).toHaveBeenCalledTimes(2);
    });
    expect(video.src).toBe(preparedSource);
    expect(video.load).toHaveBeenCalledTimes(loads);
    expect(usePlayerStore.getState().status).toBe('loading');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('starts a working retry after the startup deadline', async () => {
    await act(async () => hook.current?.play());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    vi.mocked(video.play).mockResolvedValue();
    await act(async () => hook.current?.retry());
    await act(async () => video.dispatchEvent(new Event('playing')));
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState()).toMatchObject({ status: 'playing', errorMessage: '' });
  });

  it.each(['stop', 'replace'] as const)('cancels the old deadline on %s', async action => {
    await act(async () => hook.current?.play());
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    if (action === 'stop') {
      await act(async () => hook.current?.stop());
    } else {
      await act(async () => hook.current?.play());
    }
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(usePlayerStore.getState().status).toBe(action === 'stop' ? 'idle' : 'loading');
  });
});

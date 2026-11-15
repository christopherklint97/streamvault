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

const EPISODE = {
  id: 'episode_1484136', name: 'MobLand', url: 'https://provider.invalid/episode.mkv',
  logo: '', group: '', region: '', contentType: 'series' as const, duration: 3600,
};

describe('native iPhone VOD stall watchdog', () => {
  let root: Root;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let hook: RefObject<ReturnType<typeof usePlayer> | null>;
  // Model of the WebKit media element: tests drive the clock and pause state.
  let currentTime: number;
  let paused: boolean;
  let loadedSources: string[];

  const stallReloads = () => loadedSources.filter(src => src.includes('/api/ios-hls-authorize/'))
    .slice(1);
  const advanceMedia = async (seconds: number, stepSeconds = 1) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += stepSeconds) {
      await act(async () => vi.advanceTimersByTimeAsync(stepSeconds * 1000));
      currentTime += stepSeconds;
      await act(async () => video.dispatchEvent(new Event('timeupdate')));
    }
  };
  const startPlayback = async () => {
    saveWatchProgress(EPISODE.id, 2600, 3600, 'series');
    await act(async () => hook.current?.play());
    paused = false;
    await act(async () => video.dispatchEvent(new Event('playing')));
    await advanceMedia(73);
    await advanceMedia(0.1, 0.1);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone AppleWebKit/605.1.15 Safari/604.1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    video = document.createElement('video');
    video.id = 'av-player';
    document.body.append(video);
    currentTime = 0;
    paused = true;
    loadedSources = [];
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
    // Every assigned source is a new server session.
    Object.defineProperty(video, 'src', {
      configurable: true,
      get: () => video.getAttribute('src') ?? '',
      set: (value: string) => { loadedSources.push(value); video.setAttribute('src', value); },
    });
    vi.spyOn(video, 'load').mockImplementation(() => { currentTime = 0; });
    vi.spyOn(video, 'play').mockResolvedValue();
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    usePlayerStore.setState({ currentChannel: EPISODE, status: 'idle', errorMessage: '' });
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

  it('reloads once at the absolute position after twelve seconds without progress while playing', async () => {
    await startPlayback();
    expect(video.dataset.streamOffset).toBe('2600');
    await act(async () => vi.advanceTimersByTimeAsync(11_999));
    expect(stallReloads()).toHaveLength(0);
    const plays = vi.mocked(video.play).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(stallReloads()).toHaveLength(1);
    expect(stallReloads()[0]).toContain('start=2673.1');
    expect(video.dataset.streamOffset).toBe('2673.1');
    expect(video.play).toHaveBeenCalledTimes(plays + 1);
    // The replacement session gets a longer startup window, not a second reload.
    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(stallReloads()).toHaveLength(1);
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it('keeps healthy playback that advances, even with constant stalled events', async () => {
    await startPlayback();
    for (let i = 0; i < 12; i++) {
      await act(async () => video.dispatchEvent(new Event('stalled')));
      await advanceMedia(5, 5);
    }
    expect(stallReloads()).toHaveLength(0);
  });

  it('does not reload a paused element', async () => {
    await startPlayback();
    paused = true;
    await act(async () => video.dispatchEvent(new Event('pause')));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(stallReloads()).toHaveLength(0);
    // Resuming re-arms with a full stall window measured from the resume.
    paused = false;
    await act(async () => video.dispatchEvent(new Event('play')));
    await act(async () => vi.advanceTimersByTimeAsync(11_999));
    expect(stallReloads()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(stallReloads()).toHaveLength(1);
  });

  it('bounds reloads with backoff, then surfaces the player error', async () => {
    await startPlayback();
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(stallReloads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(stallReloads()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(24_999));
    expect(stallReloads()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(stallReloads()).toHaveLength(3);
    expect(stallReloads().every(src => src.includes('start=2673.1'))).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', errorMessage: expect.stringMatching(/tap to retry/i) });
    expect(video.hasAttribute('src')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(stallReloads()).toHaveLength(3);
  });

  it('forgives earlier reloads after sustained progress', async () => {
    await startPlayback();
    for (let i = 0; i < 3; i++) {
      await act(async () => vi.advanceTimersByTimeAsync(12_000));
      expect(stallReloads()).toHaveLength(i + 1);
      await advanceMedia(35, 5);
    }
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(stallReloads()).toHaveLength(4);
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it.each(['stop', 'channel change', 'user seek', 'unmount'] as const)('cancels a pending reload on %s', async action => {
    await startPlayback();
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    const loadsBefore = loadedSources.length;
    if (action === 'stop') {
      await act(async () => hook.current?.stop());
    } else if (action === 'channel change') {
      usePlayerStore.setState({ currentChannel: { ...EPISODE, id: 'episode_2', name: 'Next' } });
      await act(async () => hook.current?.play());
    } else if (action === 'user seek') {
      await act(async () => hook.current?.seek(100));
    } else {
      await act(async () => root.unmount());
    }
    const loadsAfterAction = loadedSources.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(loadedSources).toHaveLength(loadsAfterAction);
    expect(loadedSources.slice(loadsBefore).some(src => src.includes('start=2673.1'))).toBe(false);
    if (action === 'unmount') {
      root = createRoot(container);
      await act(async () => root.render(<Harness ref={hook} />));
    }
  });
});

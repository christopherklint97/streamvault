import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seekRecordingPlayback, stopActivePlayback, usePlayer } from './usePlayer';
import { commercialSkipSession } from '../services/commercialSkipSession';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';

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
    vi.useRealTimers();
    localStorage.clear();
    useAppStore.setState({ showToast: false, toastMessage: '' });
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
});

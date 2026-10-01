import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from './usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import { saveWatchProgress } from '../services/channel-service';
import { clientLogger } from '../utils/logger';

const { hls } = vi.hoisted(() => ({ hls: { attachMedia: vi.fn(), loadSource: vi.fn(), destroy: vi.fn(), on: vi.fn() } }));
vi.mock('hls.js', () => ({ default: Object.assign(class MockHls { constructor() { return hls; } }, {
  isSupported: () => true, Events: { ERROR: 'hlsError' },
}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const Harness = forwardRef<ReturnType<typeof usePlayer>>(function Harness(_props, ref) {
  const player = usePlayer(); useImperativeHandle(ref, () => player, [player]); return null;
});

describe('finite HLS DVR player', () => {
  let root: Root;
  let video: HTMLVideoElement;
  let container: HTMLDivElement;
  let hookRef: RefObject<ReturnType<typeof usePlayer> | null>;
  beforeEach(async () => {
    vi.clearAllMocks(); localStorage.clear();
    video = document.createElement('video'); video.id = 'av-player'; document.body.append(video);
    vi.spyOn(video, 'canPlayType').mockReturnValue('');
    vi.spyOn(video, 'play').mockResolvedValue();
    usePlayerStore.setState({ currentChannel: {
      id: 'archive_live_7_1000', name: 'ESPN archive', url: '/api/archive/snapshots/s1/index.m3u8',
      logo: '', group: '', region: '', contentType: 'movies', duration: 3600, dvrHls: true,
    }, status: 'idle', errorMessage: '' });
    hookRef = createRef<ReturnType<typeof usePlayer>>();
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness ref={hookRef} />));
  });
  afterEach(async () => {
    await act(async () => hookRef.current?.stop());
    await act(async () => root.unmount()); video.remove(); container.remove(); vi.restoreAllMocks();
  });
  it('loads HLS through MSE and destroys the transport when playback stops', async () => {
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalled()); });
    expect(hls.loadSource).toHaveBeenCalledWith('/api/archive/snapshots/s1/index.m3u8');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    await act(async () => hookRef.current?.stop());
    expect(hls.destroy).toHaveBeenCalledOnce();
  });
  it('reopens a failed finite archive at its current position, then stops bounded repeats without leaving a spinner', async () => {
    const log = vi.spyOn(clientLogger, 'info');
    saveWatchProgress('archive_live_7_1000', 5, 3600, 'movies');
    Object.defineProperty(video, 'duration', { configurable: true, value: 3600 });
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3, message: 'decode' } });
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(1)); });
    video.currentTime = 45;
    await act(async () => video.dispatchEvent(new Event('error')));
    await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(2));
    expect(video.currentTime).toBe(45);
    expect(log).toHaveBeenCalledWith('Resuming from position 45.0s');
    await act(async () => video.dispatchEvent(new Event('error')));
    await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(3));
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(hls.loadSource).toHaveBeenCalledTimes(3);
    expect(usePlayerStore.getState().status).toBe('error');
    await act(async () => video.dispatchEvent(new Event('waiting')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    expect(usePlayerStore.getState().status).toBe('error');
    await act(async () => video.dispatchEvent(new Event('playing')));
    expect(usePlayerStore.getState().status).toBe('error');
  });
  it('recovers at the last confirmed playback time when the media element loses its clock', async () => {
    const log = vi.spyOn(clientLogger, 'info');
    saveWatchProgress('archive_live_7_1000', 5, 3600, 'movies');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3, message: 'decode' } });
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(1)); });
    video.currentTime = 45;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    video.currentTime = 0;
    await act(async () => video.dispatchEvent(new Event('error')));
    await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(2));
    expect(log).toHaveBeenCalledWith('Resuming from position 45.0s');
  });
  it('reopens a finite HLS session if playback makes no progress, without treating a pause as a stall', async () => {
    let paused = false;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(1)); });
    video.currentTime = 25;
    vi.useFakeTimers();
    await act(async () => video.dispatchEvent(new Event('waiting')));
    await act(async () => vi.advanceTimersByTime(15_100));
    vi.useRealTimers();
    await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(2));
    paused = true;
    await act(async () => video.dispatchEvent(new Event('pause')));
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTime(20_000));
    vi.useRealTimers();
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
  });
  it('does not mistake healthy progress after a backward seek for a stalled archive', async () => {
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(1)); });
    vi.useFakeTimers();
    video.currentTime = 120;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    await act(async () => vi.advanceTimersByTime(14_000));
    video.currentTime = 30;
    await act(async () => video.dispatchEvent(new Event('seeked')));
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    video.currentTime = 31;
    await act(async () => video.dispatchEvent(new Event('timeupdate')));
    await act(async () => vi.advanceTimersByTime(14_000));
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('lets a viewer explicitly seek away from an errored archive section using a new transport', async () => {
    const log = vi.spyOn(clientLogger, 'info');
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(1)); });
    video.currentTime = 40;
    usePlayerStore.getState().setError('Damaged section');
    await act(async () => hookRef.current?.seek(60));
    await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalledTimes(2));
    expect(log).toHaveBeenCalledWith('Resuming from position 60.0s');
    expect(usePlayerStore.getState().status).not.toBe('error');
  });
  it('reopens native finite HLS at the same position after a decode error', async () => {
    vi.mocked(video.canPlayType).mockReturnValue('maybe');
    const log = vi.spyOn(clientLogger, 'info');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3, message: 'decode' } });
    await act(async () => { hookRef.current?.play(); await Promise.resolve(); });
    expect(video.src).toContain('/api/archive/snapshots/s1/index.m3u8');
    video.currentTime = 45;
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(log).toHaveBeenCalledWith('Resuming from position 45.0s');
    expect(usePlayerStore.getState().status).toBe('loading');
  });
});

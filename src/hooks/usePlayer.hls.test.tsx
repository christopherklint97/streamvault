import { act, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from './usePlayer';
import { usePlayerStore } from '../stores/playerStore';

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
    await act(async () => root.unmount()); video.remove(); container.remove(); vi.restoreAllMocks();
  });
  it('loads HLS through MSE and destroys the transport when playback stops', async () => {
    await act(async () => { hookRef.current?.play(); await vi.waitFor(() => expect(hls.loadSource).toHaveBeenCalled()); });
    expect(hls.loadSource).toHaveBeenCalledWith('/api/archive/snapshots/s1/index.m3u8');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    await act(async () => hookRef.current?.stop());
    expect(hls.destroy).toHaveBeenCalledOnce();
  });
});

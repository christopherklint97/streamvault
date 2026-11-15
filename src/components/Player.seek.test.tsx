import { act } from '../test/act';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Player from './Player';
import { usePlayerStore } from '../stores/playerStore';

const fixture = vi.hoisted(() => ({ seek: vi.fn() }));
vi.mock('../utils/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/platform')>(), isMobile: () => true,
}));
vi.mock('../hooks/usePlayer', () => ({
  getStreamUrl: () => '',
  usePlayer: () => {
    const state = usePlayerStore();
    const noop = () => undefined;
    return {
      play: noop, stop: noop, retry: noop, togglePlay: noop,
      beginManualSeek: noop, seek: fixture.seek,
      getVideoElement: () => document.getElementById('av-player'),
      playbackPosition: 1236.5, playbackDuration: 2934,
      commercialSkip: { recordingId: null, generation: 0, phase: 'idle', enabled: false,
        segments: [], seekPending: false, undo: null },
      undoCommercialSkip: noop, subtitleTracks: [], currentSubtitleIndex: -1,
      subtitleText: '', selectSubtitleTrack: noop,
      playerState: { status: state.status, errorMessage: state.errorMessage },
    };
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setRangeValue(input: HTMLInputElement, value: number): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('seek bar gestures', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let seekBar: HTMLInputElement;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    usePlayerStore.setState({ currentChannel: {
      id: 'episode_1', name: 'Episode', contentType: 'series', url: '/unused',
      group: '', region: '', logo: '',
    }, groupChannels: [], status: 'playing', errorMessage: '' });
    video = document.createElement('video'); video.id = 'av-player';
    document.body.append(video);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Player />));
    seekBar = container.querySelector('input.seek-bar')!;
    expect(seekBar).not.toBeNull();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); video.remove();
    usePlayerStore.setState({ currentChannel: null, groupChannels: [], status: 'idle' });
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('does not seek when the bar is tapped without moving the thumb', async () => {
    // iOS: touchstart/touchend with no change event, then synthetic mouse events.
    await act(async () => {
      seekBar.dispatchEvent(new Event('touchstart', { bubbles: true }));
      seekBar.dispatchEvent(new Event('touchend', { bubbles: true }));
      seekBar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      seekBar.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(fixture.seek).not.toHaveBeenCalled();
  });

  it('seeks once to the dragged position despite the synthetic mouseup', async () => {
    await act(async () => {
      seekBar.dispatchEvent(new Event('touchstart', { bubbles: true }));
      setRangeValue(seekBar, 1500);
      seekBar.dispatchEvent(new Event('touchend', { bubbles: true }));
      seekBar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      seekBar.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(fixture.seek).toHaveBeenCalledOnce();
    expect(fixture.seek).toHaveBeenCalledWith(1500);
  });
});

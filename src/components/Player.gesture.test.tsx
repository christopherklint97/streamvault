import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Player from './Player';
import { usePlayerStore } from '../stores/playerStore';

const fixture = vi.hoisted(() => ({ retry: vi.fn(), play: vi.fn() }));
vi.mock('../utils/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/platform')>(), isMobile: () => true,
}));
vi.mock('../hooks/usePlayer', () => ({
  getStreamUrl: () => '',
  usePlayer: () => {
    const state = usePlayerStore();
    const noop = () => undefined;
    return {
      play: fixture.play, stop: noop, retry: fixture.retry, togglePlay: noop,
      beginManualSeek: noop, seek: noop,
      getVideoElement: () => document.getElementById('av-player'),
      playbackPosition: 0, playbackDuration: 0,
      commercialSkip: { recordingId: null, generation: 0, phase: 'idle', enabled: false,
        segments: [], seekPending: false, undo: null },
      undoCommercialSkip: noop, subtitleTracks: [], currentSubtitleIndex: -1,
      subtitleText: '', selectSubtitleTrack: noop,
      playerState: { status: state.status, errorMessage: state.errorMessage },
    };
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('browser playback permission', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove(); video?.remove();
    usePlayerStore.setState({ currentChannel: null, groupChannels: [], status: 'idle' });
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  it('shows a persistent Tap to play action, not a playback error, and preserves it on mobile remount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    usePlayerStore.setState({ currentChannel: {
      id: 'live_test', name: 'Test live', contentType: 'livetv', url: '/unused',
      group: '', region: '', logo: '',
    }, groupChannels: [], status: 'awaiting-gesture', errorMessage: '' });
    video = document.createElement('video'); video.id = 'av-player';
    video.dataset.channelId = 'live_test';
    Object.defineProperty(video, 'readyState', { value: 2 });
    document.body.append(video);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Player />));
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Tap to play'));
    expect(button).toBeDefined();
    expect(container.textContent).not.toContain('Playback Error');
    expect(fixture.play).not.toHaveBeenCalled();
    expect(container.querySelector('[data-player-controls]')).toBeNull();
    await act(async () => button?.click());
    expect(fixture.retry).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    await act(async () => root.render(<Player />));
    expect(container.textContent).toContain('Tap to play');
    expect(fixture.play).not.toHaveBeenCalled();
  });
});

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Player from './Player';
import { usePlayerStore } from '../stores/playerStore';

const fixture = vi.hoisted(() => ({ seek: vi.fn(), retry: vi.fn() }));
vi.mock('../utils/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/platform')>(),
  isMobile: () => false,
}));
vi.mock('../hooks/usePlayer', () => {
  const noop = () => undefined;
  return {
    getStreamUrl: () => '',
    usePlayer: () => ({
      play: noop, stop: noop, retry: fixture.retry, togglePlay: noop,
      beginManualSeek: noop, seek: fixture.seek, getVideoElement: () => null,
      playbackPosition: 14.7, playbackDuration: 6991,
      commercialSkip: { recordingId: null, generation: 0, phase: 'idle', enabled: false,
        segments: [], seekPending: false, undo: null },
      undoCommercialSkip: noop, subtitleTracks: [], currentSubtitleIndex: -1,
      subtitleText: '', selectSubtitleTrack: noop,
      playerState: { status: 'error', errorMessage: 'Archive playback could not recover at this position.' },
    }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('finite archive error escape', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    fixture.seek.mockClear(); fixture.retry.mockClear();
    usePlayerStore.setState({ currentChannel: null, groupChannels: [] });
  });
  it('leaves the skip button unobstructed and restarts at a new position on click', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'archive_live_17289_1000', name: 'F1 archive', contentType: 'movies',
      dvrHls: true, duration: 6991, url: '/api/archive/snapshots/test/index.m3u8',
      group: '', region: '', logo: '',
    }, groupChannels: [] });
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Player />));
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Skip 20s'));
    expect(button).toBeDefined();
    // The full-panel click/tap zone sits above ordinary-position error content.
    // It must not be mounted while the error escape action is visible.
    expect([...container.querySelectorAll('[class]')].some(el => el.classList.contains('z-[2]') && el.classList.contains('inset-0'))).toBe(false);
    await act(async () => button?.click());
    expect(fixture.seek).toHaveBeenCalledWith(34.7);
    expect(fixture.retry).not.toHaveBeenCalled();
  });
  it('activates the focused skip button with Enter rather than intercepting it as Retry', async () => {
    usePlayerStore.setState({ currentChannel: {
      id: 'archive_live_17289_1000', name: 'F1 archive', contentType: 'movies',
      dvrHls: true, duration: 6991, url: '/api/archive/snapshots/test/index.m3u8',
      group: '', region: '', logo: '',
    }, groupChannels: [] });
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Player />));
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Skip 20s'))!;
    button.focus();
    await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 })));
    expect(fixture.retry).not.toHaveBeenCalled();
  });
});

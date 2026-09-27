import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Player from './Player';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import type { Channel } from '../types';
import type { CommercialSkipSnapshot } from '../services/commercialSkipSession';

const commercialFixture = vi.hoisted(() => ({
  duration: 0,
  snapshot: {
    recordingId: null, generation: 0, phase: 'idle', enabled: false,
    segments: [], seekPending: false, undo: null,
  } as CommercialSkipSnapshot,
}));

vi.mock('../utils/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/platform')>(),
  isMobile: () => true,
  isIPhone: () => true,
}));
vi.mock('../hooks/usePlayer', () => {
  const noop = () => undefined;
  const player = {
    play: noop, stop: noop, retry: noop, togglePlay: noop,
    beginManualSeek: noop, seek: noop, getVideoElement: () => null,
    playbackPosition: 0, get playbackDuration() { return commercialFixture.duration; },
    get commercialSkip() { return commercialFixture.snapshot; }, undoCommercialSkip: noop,
    playerState: { status: 'playing' }, subtitleTracks: [], currentSubtitleIndex: -1,
    subtitleText: '', selectSubtitleTrack: noop,
  };
  return { usePlayer: () => player, getStreamUrl: () => '' };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channel: Channel = {
  id: 'live_1015944', name: 'US - ESPN 1 HD', url: '', logo: '', group: 'ESPN',
  region: '', contentType: 'livetv',
};

describe('player channel-list EPG', () => {
  let root: Root;
  let container: HTMLDivElement;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePlayerStore.setState({ currentChannel: null, groupChannels: [], channelListVisible: true });
    useChannelStore.setState({ programs: [], programsByChannel: new Map() });
    commercialFixture.duration = 0;
    commercialFixture.snapshot = { recordingId: null, generation: 0, phase: 'idle', enabled: false, segments: [], seekPending: false, undo: null };
  });

  it('keeps DVR seek markers but omits the persistent yellow commercial-break text', async () => {
    commercialFixture.duration = 3600;
    commercialFixture.snapshot = {
      recordingId: 'rec-1', generation: 1, phase: 'ready', enabled: true,
      segments: [{ id: 'ad-1', startSeconds: 120, endSeconds: 180, source: 'manual', confidence: null, state: 'accepted' }],
      seekPending: false, undo: { segmentId: 'ad-1', originalPosition: 125, targetPosition: 180, expiresAt: Date.now() + 10000 },
    };
    usePlayerStore.setState({
      currentChannel: { ...channel, id: 'recording_rec-1', recordingId: 'rec-1', contentType: 'movies', duration: 3600 },
      groupChannels: [], channelListVisible: false,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<Player />); });
    expect(container.querySelectorAll('[data-commercial-marker]')).toHaveLength(1);
    expect(container.querySelector('[data-commercial-skip-state]')).toBeNull();
    expect(container.querySelector('[data-commercial-break-summary]')).toBeNull();
    const undo = container.querySelector('[data-commercial-undo]');
    expect(undo).not.toBeNull();
    expect(undo?.className).not.toContain('amber');
    expect(undo?.querySelector('span')?.className).not.toContain('amber');
  });

  it.each(['empty', 'future-only'] as const)(
    'shows the current program without navigating away when the batch is %s but single-channel EPG succeeds',
    async (batchState) => {
      const now = Date.now();
      const program = {
        channelId: channel.id, title: 'SportsCenter', description: '',
        start: new Date(now - 60_000).toISOString(), stop: new Date(now + 60_000).toISOString(),
        category: 'Sports',
      };
      const requests: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('/api/epg/batch')) return new Response(JSON.stringify({ programs: batchState === 'empty' ? {} : {
          [channel.id]: [{ ...program, title: 'Later', start: new Date(now + 7_200_000).toISOString(), stop: new Date(now + 10_800_000).toISOString() }],
        } }), { status: 200 });
        if (url.includes('/api/epg/channel/')) return new Response(JSON.stringify({ programs: [program] }), { status: 200 });
        throw new Error(`Unexpected request: ${url}`);
      }));
      useChannelStore.setState({ programs: [], programsByChannel: new Map() });
      usePlayerStore.setState({ currentChannel: channel, groupChannels: [channel], channelListVisible: true });
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      await act(async () => { root.render(<Player />); });
      expect(requests.some(url => url.includes('/api/epg/batch'))).toBe(true);
      expect(requests.some(url => url.includes('/api/epg/channel/live_1015944'))).toBe(true);
      expect(useChannelStore.getState().programsByChannel.get(channel.id)?.[0]?.title).toBe('SportsCenter');
      expect(container.querySelector('[data-live-channel-row] [data-live-epg-title]')?.textContent).toBe('SportsCenter');
    },
  );

  it('retries selected-channel EPG while the player stays open after a cache correction', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    let channelCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/epg/batch')) return new Response(JSON.stringify({ programs: {} }), { status: 200 });
      if (url.includes('/api/epg/channel/')) {
        channelCalls++;
        const programs = channelCalls === 1 ? [] : [{
          channelId: channel.id, title: 'SportsCenter', description: '', category: 'Sports',
          start: new Date(now - 60_000).toISOString(), stop: new Date(now + 60_000).toISOString(),
        }];
        return new Response(JSON.stringify({ programs }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useChannelStore.setState({ programs: [], programsByChannel: new Map() });
    usePlayerStore.setState({ currentChannel: channel, groupChannels: [channel], channelListVisible: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<Player />); });
    expect(channelCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(channelCalls).toBeGreaterThan(1);
    expect(useChannelStore.getState().programsByChannel.get(channel.id)?.[0]?.title).toBe('SportsCenter');
  });

  it('fills every ESPN row after an initially empty batch while the player stays open', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sibling: Channel = { ...channel, id: 'live_71935', name: 'US - ESPN 2 HD' };
    const airing = (id: string, title: string) => ({
      channelId: id, title, description: '',
      start: new Date(now - 60_000).toISOString(), stop: new Date(now + 60_000).toISOString(),
    });
    let batchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/epg/batch')) {
        batchCalls++;
        return new Response(JSON.stringify({ programs: batchCalls === 1 ? {} : {
          [channel.id]: [airing(channel.id, 'SportsCenter')],
          [sibling.id]: [airing(sibling.id, 'NFL Live')],
        } }), { status: 200 });
      }
      if (url.includes('/api/epg/channel/')) {
        return new Response(JSON.stringify({ programs: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useChannelStore.setState({ programs: [], programsByChannel: new Map() });
    usePlayerStore.setState({ currentChannel: channel, groupChannels: [channel, sibling], channelListVisible: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<Player />); });
    expect(batchCalls).toBe(1);
    expect(Array.from(container.querySelectorAll('[data-live-channel-row]')).map(el => el.textContent?.includes('No guide'))).toEqual([true, true]);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(batchCalls).toBeGreaterThan(1);
    expect(Array.from(container.querySelectorAll('[data-live-epg-title]')).map(el => el.textContent)).toEqual(['SportsCenter', 'NFL Live']);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBackendScopedStores } from './backendReset';
import { useAppStore } from './appStore';
import { usePlayerStore } from './playerStore';
import { useRecordingStore } from './recordingStore';
import { useFavoritesStore } from './favoritesStore';

const { stopActivePlayback } = vi.hoisted(() => ({ stopActivePlayback: vi.fn() }));

vi.mock('../hooks/usePlayer', () => ({ stopActivePlayback }));

describe('resetBackendScopedStores', () => {
  beforeEach(() => {
    stopActivePlayback.mockClear();
    useAppStore.setState({
      currentView: 'settings',
      viewStack: ['channels'],
      selectedGroup: 'Sports',
      selectedSeries: { id: 'series-1' } as never,
      selectedMovie: { id: 'movie-1' } as never,
      selectedRecordingId: 'recording-1',
      navigationBlocker: () => true,
      browseStates: { channels: { searchQuery: 'news', selectedGroup: 'News' } },
      visitedViews: { channels: true, settings: true },
    });
    usePlayerStore.setState({
      currentChannel: { id: 'channel-1' } as never,
      status: 'playing',
      errorMessage: 'old error',
      groupChannels: [{ id: 'channel-1' } as never],
      groupChannelsLoading: true,
      channelListVisible: false,
      audioOnly: true,
    });
    useRecordingStore.setState({
      recordings: [{ id: 'recording-1' } as never],
      rules: [{ id: 'rule-1' } as never],
      status: {} as never,
      commercialSegments: { 'recording-1': {} as never },
      commercialSegmentsLoading: { 'recording-1': true },
      commercialSegmentsError: { 'recording-1': 'old error' },
      loading: true,
    });
    useFavoritesStore.setState({
      favoriteIds: new Set(['channel-1']),
      lists: [{ id: 'list-1', name: 'Old', channelIds: ['channel-1'] }],
    });
    localStorage.setItem('streamvault_favorites', JSON.stringify(['channel-1']));
    localStorage.setItem('streamvault_favorite_lists', JSON.stringify([{ id: 'list-1' }]));
    localStorage.setItem('streamvault_recent_channels', JSON.stringify(['channel-1']));
    localStorage.setItem('streamvault_last_watched', JSON.stringify('channel-1'));
    localStorage.setItem('streamvault_watch_progress', JSON.stringify({ 'channel-1': { position: 60 } }));
  });

  it('still clears stores if transport cleanup throws', () => {
    stopActivePlayback.mockImplementationOnce(() => { throw new Error('cleanup failed'); });

    expect(() => resetBackendScopedStores()).not.toThrow();
    expect(usePlayerStore.getState().currentChannel).toBeNull();
    expect(useRecordingStore.getState().recordings).toEqual([]);
    expect(useAppStore.getState().selectedSeries).toBeNull();
  });

  it('clears every in-memory value tied to the previous backend', () => {
    resetBackendScopedStores(true);

    expect(stopActivePlayback).toHaveBeenCalledOnce();

    expect(useAppStore.getState()).toMatchObject({
      viewStack: [],
      selectedGroup: null,
      selectedSeries: null,
      selectedMovie: null,
      selectedRecordingId: null,
      navigationBlocker: null,
      browseStates: {},
      visitedViews: { settings: true },
    });
    expect(usePlayerStore.getState()).toMatchObject({
      currentChannel: null,
      status: 'idle',
      errorMessage: '',
      groupChannels: [],
      groupChannelsLoading: false,
      channelListVisible: true,
      audioOnly: false,
    });
    expect(useRecordingStore.getState()).toMatchObject({
      recordings: [],
      rules: [],
      status: null,
      commercialSegments: {},
      commercialSegmentsLoading: {},
      commercialSegmentsError: {},
      loading: false,
    });
    expect(useFavoritesStore.getState().favoriteIds.size).toBe(0);
    expect(useFavoritesStore.getState().lists).toEqual([]);
    expect(localStorage.getItem('streamvault_favorites')).toBe(JSON.stringify([]));
    expect(localStorage.getItem('streamvault_favorite_lists')).toBe(JSON.stringify([]));
    expect(localStorage.getItem('streamvault_recent_channels')).toBe(JSON.stringify([]));
    expect(localStorage.getItem('streamvault_last_watched')).toBe('null');
    expect(localStorage.getItem('streamvault_watch_progress')).toBe(JSON.stringify({}));
  });
});

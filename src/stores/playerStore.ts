import { create } from 'zustand';
import type { Channel, PlayerState } from '../types';
import { trackWatch } from '../services/channel-service';
import { useChannelStore } from './channelStore';
import { apiFetch } from '../services/api';

interface PlayerStoreState extends PlayerState {
  volume: number;
  groupChannels: Channel[];
  groupChannelsLoading: boolean;
  channelListVisible: boolean;
  audioOnly: boolean;
}

interface PlayerStoreActions {
  setChannel: (channel: Channel) => void;
  setStatus: (status: PlayerState['status']) => void;
  setError: (message: string) => void;
  clearError: () => void;
  fetchGroupChannels: (group: string) => Promise<void>;
  switchToChannel: (channel: Channel) => void;
  switchByOffset: (offset: number) => void;
  toggleChannelList: () => void;
  setAudioOnly: (audioOnly: boolean) => void;
}

let groupFetchGeneration = 0;
let pendingGroup: string | null = null;
let groupRequestController: AbortController | null = null;

export const usePlayerStore = create<PlayerStoreState & PlayerStoreActions>()((set, get) => ({
  status: 'idle',
  currentChannel: null,
  errorMessage: '',
  volume: 100,
  groupChannels: [],
  groupChannelsLoading: false,
  channelListVisible: true,
  audioOnly: false,

  setChannel: (channel: Channel) => {
    set({
      currentChannel: channel,
      status: 'loading',
      errorMessage: '',
      audioOnly: false,
    });
    trackWatch(channel);
    // Auto-fetch group channels for live TV
    if (channel.contentType === 'livetv' && channel.group) {
      const state = get();
      // Only fetch if we don't already have channels for this group
      const existingGroup = state.groupChannels[0]?.group;
      if (existingGroup !== channel.group) {
        get().fetchGroupChannels(channel.group);
      } else if (pendingGroup && pendingGroup !== channel.group) {
        // Returning to cached A must invalidate B, including its finally path.
        groupFetchGeneration++;
        groupRequestController?.abort();
        pendingGroup = null;
        set({ groupChannelsLoading: false });
      }
    }
  },

  setStatus: (status: PlayerState['status']) => {
    set({ status });
  },

  setError: (message: string) => {
    set({ status: 'error', errorMessage: message });
  },

  clearError: () => {
    set({ status: 'idle', errorMessage: '' });
  },

  fetchGroupChannels: async (group: string) => {
    const fetchGeneration = ++groupFetchGeneration;
    groupRequestController?.abort();
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    groupRequestController = controller;
    pendingGroup = group;
    const { apiBaseUrl: base, backendGeneration } = useChannelStore.getState();
    const isCurrent = () => groupFetchGeneration === fetchGeneration &&
      useChannelStore.getState().backendGeneration === backendGeneration;
    set({ groupChannelsLoading: true });
    try {
      const channels: Channel[] = [];
      let after: string | null = null;
      do {
        const params = new URLSearchParams({ type: 'livetv', group, limit: '200' });
        if (after) params.set('after', after);
        const data = await apiFetch<{ channels?: Channel[]; nextCursor?: string | null }>(base, `/api/browse?${params}`,
          { signal: controller?.signal, timeoutMs: 10_000 });
        if (!isCurrent()) return;
        channels.push(...(data.channels || []));
        after = data.nextCursor || null;
        set({ groupChannels: [...channels], groupChannelsLoading: Boolean(after) });
      } while (after);
    } catch {
      if (!isCurrent()) return;
      set({ groupChannelsLoading: false });
    } finally {
      if (isCurrent()) { pendingGroup = null; groupRequestController = null; }
    }
  },

  switchToChannel: (channel: Channel) => {
    set({
      currentChannel: channel,
      status: 'loading',
      errorMessage: '',
      ...(channel.contentType === 'livetv' ? {} : { audioOnly: false }),
    });
    trackWatch(channel);
  },

  switchByOffset: (offset: number) => {
    const { currentChannel, groupChannels } = get();
    if (!currentChannel || groupChannels.length === 0) return;
    const currentIndex = groupChannels.findIndex(c => c.id === currentChannel.id);
    if (currentIndex === -1) return;
    const nextIndex = currentIndex + offset;
    if (nextIndex < 0 || nextIndex >= groupChannels.length) return;
    const next = groupChannels[nextIndex];
    set({
      currentChannel: next,
      status: 'loading',
      errorMessage: '',
    });
    trackWatch(next);
  },

  toggleChannelList: () => {
    set((s) => ({ channelListVisible: !s.channelListVisible }));
  },

  setAudioOnly: (audioOnly: boolean) => {
    set({ audioOnly });
  },
}));

export function resetPlayerBackendState(): void {
  groupFetchGeneration++;
  pendingGroup = null;
  groupRequestController?.abort();
  groupRequestController = null;
  usePlayerStore.setState({
    status: 'idle',
    currentChannel: null,
    errorMessage: '',
    groupChannels: [],
    groupChannelsLoading: false,
    channelListVisible: true,
    audioOnly: false,
  });
}

import { create } from 'zustand';
import type { Channel, PlayerState } from '../types';
import { trackWatch } from '../services/channel-service';
import { useChannelStore } from './channelStore';

interface PlayerStoreState extends PlayerState {
  volume: number;
  groupChannels: Channel[];
  groupChannelsLoading: boolean;
  channelListVisible: boolean;
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
}

export const usePlayerStore = create<PlayerStoreState & PlayerStoreActions>()((set, get) => ({
  status: 'idle',
  currentChannel: null,
  errorMessage: '',
  volume: 100,
  groupChannels: [],
  groupChannelsLoading: false,
  channelListVisible: true,

  setChannel: (channel: Channel) => {
    set({
      currentChannel: channel,
      status: 'loading',
      errorMessage: '',
    });
    trackWatch(channel);
    // Auto-fetch group channels for live TV
    if (channel.contentType === 'livetv' && channel.group) {
      const state = get();
      // Only fetch if we don't already have channels for this group
      const existingGroup = state.groupChannels[0]?.group;
      if (existingGroup !== channel.group) {
        get().fetchGroupChannels(channel.group);
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
    set({ groupChannelsLoading: true });
    try {
      const base = useChannelStore.getState().apiBaseUrl;
      const res = await fetch(`${base}/api/channels?group=${encodeURIComponent(group)}`);
      if (!res.ok) throw new Error('Failed to fetch group channels');
      const data = await res.json();
      const channels: Channel[] = data.channels || [];
      set({ groupChannels: channels, groupChannelsLoading: false });
    } catch {
      set({ groupChannelsLoading: false });
    }
  },

  switchToChannel: (channel: Channel) => {
    set({
      currentChannel: channel,
      status: 'loading',
      errorMessage: '',
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
}));

import { create } from 'zustand';
import type { Channel, PlayerState } from '../types';
import { trackWatch } from '../services/channel-service';

interface PlayerStoreState extends PlayerState {
  volume: number;
}

interface PlayerStoreActions {
  setChannel: (channel: Channel) => void;
  setStatus: (status: PlayerState['status']) => void;
  setError: (message: string) => void;
  clearError: () => void;
}

export const usePlayerStore = create<PlayerStoreState & PlayerStoreActions>()((set) => ({
  status: 'idle',
  currentChannel: null,
  errorMessage: '',
  volume: 100,

  setChannel: (channel: Channel) => {
    set({
      currentChannel: channel,
      status: 'loading',
      errorMessage: '',
    });
    trackWatch(channel);
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
}));

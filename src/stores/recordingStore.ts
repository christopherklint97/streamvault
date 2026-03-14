import { create } from 'zustand';
import type { Recording, RecordingRule, RecordingStatusInfo } from '../types';
import { useChannelStore, SAME_ORIGIN } from './channelStore';

interface RecordingState {
  recordings: Recording[];
  rules: RecordingRule[];
  status: RecordingStatusInfo | null;
  loading: boolean;
}

function getBaseUrl(): string {
  return SAME_ORIGIN ? '' : useChannelStore.getState().apiBaseUrl;
}

async function apiFetch(path: string, options?: RequestInit) {
  const url = `${getBaseUrl()}${path}`;
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

interface RecordingActions {
  fetchRecordings: (status?: string) => Promise<void>;
  fetchRules: () => Promise<void>;
  fetchStatus: () => Promise<void>;
  createRecording: (channelId: string, title: string, startTime: number, endTime: number) => Promise<Recording | null>;
  createFromProgram: (channelId: string, programStart: number, programStop: number, title: string) => Promise<Recording | null>;
  cancelRecording: (id: string) => Promise<void>;
  stopRecording: (id: string) => Promise<void>;
  deleteRecording: (id: string) => Promise<void>;
  createRule: (channelId: string, channelName: string, matchTitle: string, matchType?: string) => Promise<RecordingRule | null>;
  updateRule: (id: string, updates: Partial<{ matchTitle: string; matchType: string; enabled: boolean; paddingBefore: number; paddingAfter: number; maxRecordings: number }>) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
}

export const useRecordingStore = create<RecordingState & RecordingActions>()((set, get) => ({
  recordings: [],
  rules: [],
  status: null,
  loading: false,

  fetchRecordings: async (status?: string) => {
    set({ loading: true });
    try {
      const params = status ? `?status=${encodeURIComponent(status)}` : '';
      const data = await apiFetch(`/api/recordings${params}`);
      set({ recordings: data.recordings || [] });
    } catch {
      // non-critical
    } finally {
      set({ loading: false });
    }
  },

  fetchRules: async () => {
    try {
      const data = await apiFetch('/api/recording-rules');
      set({ rules: data.rules || [] });
    } catch {
      // non-critical
    }
  },

  fetchStatus: async () => {
    try {
      const data = await apiFetch('/api/recording-status');
      set({ status: data });
    } catch {
      // non-critical
    }
  },

  createRecording: async (channelId, title, startTime, endTime) => {
    try {
      const data = await apiFetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, title, startTime, endTime }),
      });
      await get().fetchRecordings();
      return data.recording;
    } catch {
      return null;
    }
  },

  createFromProgram: async (channelId, programStart, programStop, title) => {
    try {
      const data = await apiFetch('/api/recordings/from-program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, programStart, programStop, title }),
      });
      await get().fetchRecordings();
      return data.recording;
    } catch {
      return null;
    }
  },

  cancelRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}/cancel`, { method: 'POST' });
      await get().fetchRecordings();
    } catch {
      // non-critical
    }
  },

  stopRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}/stop`, { method: 'POST' });
      await get().fetchRecordings();
    } catch {
      // non-critical
    }
  },

  deleteRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}`, { method: 'DELETE' });
      set({ recordings: get().recordings.filter(r => r.id !== id) });
    } catch {
      // non-critical
    }
  },

  createRule: async (channelId, channelName, matchTitle, matchType) => {
    try {
      const data = await apiFetch('/api/recording-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, channelName, matchTitle, matchType: matchType || 'contains' }),
      });
      await get().fetchRules();
      return data.rule;
    } catch {
      return null;
    }
  },

  updateRule: async (id, updates) => {
    try {
      await apiFetch(`/api/recording-rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      await get().fetchRules();
    } catch {
      // non-critical
    }
  },

  deleteRule: async (id) => {
    try {
      await apiFetch(`/api/recording-rules/${id}`, { method: 'DELETE' });
      set({ rules: get().rules.filter(r => r.id !== id) });
    } catch {
      // non-critical
    }
  },
}));

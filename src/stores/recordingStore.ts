import { create } from 'zustand';
import type { Recording, RecordingRule, RecordingStatusInfo } from '../types';
import { useChannelStore, SAME_ORIGIN } from './channelStore';
import { useAppStore } from './appStore';

const toast = (msg: string) => useAppStore.getState().showToastMessage(msg);

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
    } catch (err) {
      toast(`Failed to fetch recordings: ${err}`);
    } finally {
      set({ loading: false });
    }
  },

  fetchRules: async () => {
    try {
      const data = await apiFetch('/api/recording-rules');
      set({ rules: data.rules || [] });
    } catch (err) {
      toast(`Failed to fetch rules: ${err}`);
    }
  },

  fetchStatus: async () => {
    try {
      const data = await apiFetch('/api/recording-status');
      set({ status: data });
    } catch (err) {
      toast(`Failed to fetch recording status: ${err}`);
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
    } catch (err) {
      toast(`Failed to create recording: ${err}`);
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
    } catch (err) {
      toast(`Failed to create recording: ${err}`);
      return null;
    }
  },

  cancelRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}/cancel`, { method: 'POST' });
      await get().fetchRecordings();
    } catch (err) {
      toast(`Failed to cancel recording: ${err}`);
    }
  },

  stopRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}/stop`, { method: 'POST' });
      await get().fetchRecordings();
    } catch (err) {
      toast(`Failed to stop recording: ${err}`);
    }
  },

  deleteRecording: async (id) => {
    try {
      await apiFetch(`/api/recordings/${id}`, { method: 'DELETE' });
      set({ recordings: get().recordings.filter(r => r.id !== id) });
    } catch (err) {
      toast(`Failed to delete recording: ${err}`);
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
    } catch (err) {
      toast(`Failed to create rule: ${err}`);
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
    } catch (err) {
      toast(`Failed to update rule: ${err}`);
    }
  },

  deleteRule: async (id) => {
    try {
      await apiFetch(`/api/recording-rules/${id}`, { method: 'DELETE' });
      set({ rules: get().rules.filter(r => r.id !== id) });
    } catch (err) {
      toast(`Failed to delete rule: ${err}`);
    }
  },
}));

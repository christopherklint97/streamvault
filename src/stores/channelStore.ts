import { create } from 'zustand';
import type { Channel, Program } from '../types';
import { getItem, setItem } from '../utils/storage';

export type InputMode = 'xtream' | 'manual';
export type SyncInterval = 'startup' | '6h' | '12h' | '24h' | 'manual';
export type LoadingPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done' | 'error';

export interface XtreamCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

interface ChannelState {
  channels: Channel[];
  programs: Program[];
  programsByChannel: Map<string, Program[]>;
  groups: string[];
  regions: string[];
  selectedGroup: string;
  selectedRegion: string;
  isLoading: boolean;
  error: string | null;
  playlistUrl: string;
  epgUrl: string;
  inputMode: InputMode;
  xtreamCredentials: XtreamCredentials;
  loadingPhase: LoadingPhase;
  loadingMessage: string;
  channelCount: number;
  syncInterval: SyncInterval;
  lastSyncTime: number;
  apiBaseUrl: string;
  _hydrated: boolean;
}

function buildProgramIndex(programs: Program[]): Map<string, Program[]> {
  const index = new Map<string, Program[]>();
  for (const p of programs) {
    let list = index.get(p.channelId);
    if (!list) {
      list = [];
      index.set(p.channelId, list);
    }
    list.push(p);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  return index;
}

declare const __SERVER_URL__: string;
const API_BASE_URL_KEY = 'streamvault_api_url';
const DEFAULT_SERVER_URL: string = typeof __SERVER_URL__ !== 'undefined' ? __SERVER_URL__ : '';

interface ChannelActions {
  setApiBaseUrl: (url: string) => void;
  fetchChannels: () => Promise<void>;
  fetchPrograms: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  saveConfig: (config: Record<string, string>) => Promise<void>;
  triggerSync: () => Promise<void>;
  cancelSync: () => void;
  pollStatus: () => Promise<void>;
  setSelectedGroup: (group: string) => void;
  setSelectedRegion: (region: string) => void;
  hydrate: () => Promise<void>;
}

async function apiFetch(baseUrl: string, path: string, options?: RequestInit) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export const useChannelStore = create<ChannelState & ChannelActions>()((set, get) => ({
  channels: [],
  programs: [],
  programsByChannel: new Map(),
  groups: ['All'],
  regions: ['All'],
  selectedGroup: 'All',
  selectedRegion: 'All',
  isLoading: false,
  error: null,
  playlistUrl: '',
  epgUrl: '',
  inputMode: 'xtream',
  xtreamCredentials: { serverUrl: '', username: '', password: '' },
  loadingPhase: 'idle',
  loadingMessage: '',
  channelCount: 0,
  syncInterval: '24h',
  lastSyncTime: 0,
  apiBaseUrl: getItem<string>(API_BASE_URL_KEY, DEFAULT_SERVER_URL),
  _hydrated: false,

  setApiBaseUrl: (url: string) => {
    set({ apiBaseUrl: url });
    setItem(API_BASE_URL_KEY, url);
  },

  fetchChannels: async () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    try {
      const data = await apiFetch(apiBaseUrl, '/api/channels');
      const channels: Channel[] = data.channels;
      set({
        channels,
        groups: data.groups,
        regions: data.regions,
        channelCount: channels.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch channels';
      set({ error: msg });
    }
  },

  fetchPrograms: async () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    try {
      const now = Date.now();
      const to = now + 24 * 60 * 60 * 1000;
      const data = await apiFetch(apiBaseUrl, `/api/programs?from=${now - 6 * 60 * 60 * 1000}&to=${to}`);
      const programs: Program[] = data.programs.map((p: { channelId: string; title: string; description: string; start: string; stop: string; category: string }) => ({
        channelId: p.channelId,
        title: p.title,
        description: p.description,
        start: new Date(p.start),
        stop: new Date(p.stop),
        category: p.category,
      }));
      set({
        programs,
        programsByChannel: buildProgramIndex(programs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch programs';
      set({ error: msg });
    }
  },

  fetchConfig: async () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    try {
      const data = await apiFetch(apiBaseUrl, '/api/config');
      set({
        inputMode: data.inputMode || 'xtream',
        playlistUrl: data.playlistUrl || '',
        epgUrl: data.epgUrl || '',
        xtreamCredentials: {
          serverUrl: data.xtreamServer || '',
          username: data.xtreamUsername || '',
          password: data.xtreamPassword || '',
        },
        syncInterval: data.syncInterval || '24h',
      });
    } catch {
      // Config fetch failure is non-critical
    }
  },

  saveConfig: async (config: Record<string, string>) => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    try {
      await apiFetch(apiBaseUrl, '/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      // Update local state to match
      if (config.inputMode) set({ inputMode: config.inputMode as InputMode });
      if (config.playlistUrl !== undefined) set({ playlistUrl: config.playlistUrl });
      if (config.epgUrl !== undefined) set({ epgUrl: config.epgUrl });
      if (config.xtreamServer !== undefined || config.xtreamUsername !== undefined || config.xtreamPassword !== undefined) {
        const creds = get().xtreamCredentials;
        set({
          xtreamCredentials: {
            serverUrl: config.xtreamServer ?? creds.serverUrl,
            username: config.xtreamUsername ?? creds.username,
            password: config.xtreamPassword ?? creds.password,
          },
        });
      }
      if (config.syncInterval) set({ syncInterval: config.syncInterval as SyncInterval });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save config';
      set({ error: msg });
    }
  },

  triggerSync: async () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    set({ isLoading: true, error: null, loadingPhase: 'fetching-playlist', loadingMessage: 'Starting sync...' });
    try {
      await apiFetch(apiBaseUrl, '/api/sync', { method: 'POST' });
      // Start polling for status
      get().pollStatus();
      pollInterval = setInterval(() => { get().pollStatus(); }, 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start sync';
      set({ isLoading: false, error: msg, loadingPhase: 'idle', loadingMessage: '' });
    }
  },

  cancelSync: () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    stopPolling();
    apiFetch(apiBaseUrl, '/api/sync/cancel', { method: 'POST' }).catch(() => {});
    set({ isLoading: false, loadingPhase: 'idle', loadingMessage: 'Sync cancelled' });
  },

  pollStatus: async () => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) return;
    try {
      const status = await apiFetch(apiBaseUrl, '/api/status');
      set({
        loadingPhase: status.phase,
        loadingMessage: status.message,
        channelCount: status.channelCount,
        lastSyncTime: status.lastSyncTime,
        isLoading: status.isSyncing,
      });

      if (!status.isSyncing) {
        stopPolling();
        // Sync finished — fetch fresh data
        if (status.phase === 'done') {
          await Promise.all([get().fetchChannels(), get().fetchPrograms()]);
        }
      }
    } catch {
      stopPolling();
      set({ isLoading: false, loadingPhase: 'idle' });
    }
  },

  setSelectedGroup: (group: string) => set({ selectedGroup: group }),
  setSelectedRegion: (region: string) => set({ selectedRegion: region }),

  hydrate: async () => {
    if (get()._hydrated) return;
    const { apiBaseUrl } = get();
    if (!apiBaseUrl) {
      set({ _hydrated: true });
      return;
    }
    try {
      // Fetch config, channels, and programs in parallel
      await Promise.all([
        get().fetchConfig(),
        get().fetchChannels(),
        get().fetchPrograms(),
      ]);

      // Check if server is currently syncing
      const status = await apiFetch(apiBaseUrl, '/api/status');
      if (status.isSyncing) {
        set({ isLoading: true, loadingPhase: status.phase, loadingMessage: status.message });
        pollInterval = setInterval(() => { get().pollStatus(); }, 2000);
      }
      set({ lastSyncTime: status.lastSyncTime, _hydrated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cannot connect to server';
      set({ error: msg, _hydrated: true });
    }
  },
}));

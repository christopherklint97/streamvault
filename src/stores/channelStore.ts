import { create } from 'zustand';
import type { Channel, Program, Category } from '../types';
import { getItem, setItem } from '../utils/storage';

export type InputMode = 'xtream' | 'manual';
export type SyncInterval = 'startup' | '6h' | '12h' | '24h' | 'manual';
export type LoadingPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done' | 'error';

export interface XtreamCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

const PAGE_SIZE = 20;

interface ChannelState {
  channels: Channel[];
  programs: Program[];
  programsByChannel: Map<string, Program[]>;
  categories: Category[];
  groups: string[];
  regions: string[];
  contentTypeCounts: Record<string, number>;
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
  channelTotal: number;
  hasMore: boolean;
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
// When served from the same origin (PWA), API is always available via relative paths
export const SAME_ORIGIN = !DEFAULT_SERVER_URL;
/** Check if API is reachable — same-origin always works, remote needs a URL */
function hasApi(apiBaseUrl: string): boolean {
  return SAME_ORIGIN || !!apiBaseUrl;
}

interface ChannelActions {
  setApiBaseUrl: (url: string) => void;
  fetchCategories: (contentType: string) => Promise<void>;
  fetchChannels: (group?: string) => Promise<void>;
  fetchMoreChannels: () => Promise<void>;
  fetchPrograms: () => Promise<void>;
  fetchEpgForStream: (streamId: number) => Promise<Program[]>;
  searchChannels: (query: string, contentType?: string) => Promise<Channel[]>;
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

let pollInterval: ReturnType<typeof setTimeout> | null = null;
let fetchAbortController: AbortController | null = null;

function stopPolling() {
  if (pollInterval) {
    clearTimeout(pollInterval);
    pollInterval = null;
  }
}

export const useChannelStore = create<ChannelState & ChannelActions>()((set, get) => ({
  channels: [],
  programs: [],
  programsByChannel: new Map(),
  categories: [],
  groups: ['All'],
  regions: ['All'],
  contentTypeCounts: {},
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
  channelTotal: 0,
  hasMore: false,
  syncInterval: '24h',
  lastSyncTime: 0,
  apiBaseUrl: SAME_ORIGIN ? '' : getItem<string>(API_BASE_URL_KEY, DEFAULT_SERVER_URL),
  _hydrated: false,

  setApiBaseUrl: (url: string) => {
    set({ apiBaseUrl: url });
    setItem(API_BASE_URL_KEY, url);
  },

  fetchCategories: async (contentType: string) => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    try {
      const data = await apiFetch(apiBaseUrl, `/api/categories?type=${encodeURIComponent(contentType)}`);
      set({ categories: data.categories || [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch categories';
      set({ error: msg });
    }
  },

  fetchChannels: async (group?: string) => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    // Abort any in-flight channel fetch
    if (fetchAbortController) fetchAbortController.abort();
    fetchAbortController = new AbortController();
    const signal = fetchAbortController.signal;
    try {
      const params = new URLSearchParams();
      if (group && group !== 'All') {
        params.set('group', group);
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', '0');
      }
      const qs = params.toString();
      const data = await apiFetch(apiBaseUrl, `/api/channels${qs ? '?' + qs : ''}`, { signal });
      if (signal.aborted) return;
      const channels: Channel[] = data.channels;
      const total: number = data.total ?? channels.length;
      set({
        channels,
        groups: data.groups,
        regions: data.regions,
        contentTypeCounts: data.contentTypeCounts || {},
        channelCount: channels.length,
        channelTotal: total,
        hasMore: channels.length < total,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Failed to fetch channels';
      set({ error: msg });
    }
  },

  fetchMoreChannels: async () => {
    const { apiBaseUrl, channels, channelTotal, hasMore, selectedGroup } = get();
    if (!hasApi(apiBaseUrl) || !hasMore) return;
    if (!selectedGroup || selectedGroup === 'All') return;
    try {
      const params = new URLSearchParams({
        group: selectedGroup,
        limit: String(PAGE_SIZE),
        offset: String(channels.length),
      });
      const data = await apiFetch(apiBaseUrl, `/api/channels?${params}`);
      const newChannels: Channel[] = data.channels;
      const merged = [...channels, ...newChannels];
      const total: number = data.total ?? channelTotal;
      set({
        channels: merged,
        channelCount: merged.length,
        channelTotal: total,
        hasMore: merged.length < total,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load more';
      set({ error: msg });
    }
  },

  fetchPrograms: async () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    try {
      const now = Date.now();
      const to = now + 6 * 60 * 60 * 1000;
      const data = await apiFetch(apiBaseUrl, `/api/programs?from=${now - 2 * 60 * 60 * 1000}&to=${to}`);
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

  fetchEpgForStream: async (streamId: number) => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return [];
    try {
      const data = await apiFetch(apiBaseUrl, `/api/epg/${streamId}`);
      const programs: Program[] = data.programs.map((p: { channelId: string; title: string; description: string; start: string; stop: string; category: string }) => ({
        channelId: p.channelId,
        title: p.title,
        description: p.description,
        start: new Date(p.start),
        stop: new Date(p.stop),
        category: p.category,
      }));
      // Merge into existing programs index
      const { programsByChannel } = get();
      const newIndex = new Map(programsByChannel);
      for (const p of programs) {
        let list = newIndex.get(p.channelId);
        if (!list) {
          list = [];
          newIndex.set(p.channelId, list);
        }
        // Avoid duplicates by checking start time
        if (!list.some(existing => existing.start.getTime() === p.start.getTime())) {
          list.push(p);
        }
      }
      for (const list of newIndex.values()) {
        list.sort((a, b) => a.start.getTime() - b.start.getTime());
      }
      set({ programsByChannel: newIndex });
      return programs;
    } catch {
      return [];
    }
  },

  searchChannels: async (query: string, contentType?: string) => {
    const { apiBaseUrl } = get();
    if (!apiBaseUrl || !query.trim()) return [];
    try {
      const params = new URLSearchParams({ q: query });
      if (contentType) params.set('type', contentType);
      const data = await apiFetch(apiBaseUrl, `/api/search?${params}`);
      return data.channels as Channel[];
    } catch {
      return [];
    }
  },

  fetchConfig: async () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
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
    if (!hasApi(apiBaseUrl)) return;
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
    if (!hasApi(apiBaseUrl)) return;
    set({ isLoading: true, error: null, loadingPhase: 'fetching-playlist', loadingMessage: 'Starting sync...' });
    try {
      await apiFetch(apiBaseUrl, '/api/sync', { method: 'POST' });
      // Start polling for status with exponential backoff
      get().pollStatus();
      let pollDelay = 2000;
      const schedulePoll = () => {
        pollInterval = setTimeout(() => {
          get().pollStatus().then(() => {
            if (get().isLoading) {
              pollDelay = Math.min(pollDelay * 1.5, 10000);
              schedulePoll();
            }
          });
        }, pollDelay);
      };
      schedulePoll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start sync';
      set({ isLoading: false, error: msg, loadingPhase: 'idle', loadingMessage: '' });
    }
  },

  cancelSync: () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    stopPolling();
    apiFetch(apiBaseUrl, '/api/sync/cancel', { method: 'POST' }).catch(() => {});
    set({ isLoading: false, loadingPhase: 'idle', loadingMessage: 'Sync cancelled' });
  },

  pollStatus: async () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
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

  setSelectedGroup: (group: string) => {
    set({ selectedGroup: group });
    get().fetchChannels(group);
  },
  setSelectedRegion: (region: string) => set({ selectedRegion: region }),

  hydrate: async () => {
    if (get()._hydrated) return;
    const { apiBaseUrl } = get();
    if (!SAME_ORIGIN && !apiBaseUrl) {
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
        let pollDelay = 2000;
        const schedulePoll = () => {
          pollInterval = setTimeout(() => {
            get().pollStatus().then(() => {
              if (get().isLoading) {
                pollDelay = Math.min(pollDelay * 1.5, 10000);
                schedulePoll();
              }
            });
          }, pollDelay);
        };
        schedulePoll();
      }
      set({ lastSyncTime: status.lastSyncTime, _hydrated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cannot connect to server';
      set({ error: msg, _hydrated: true });
    }
  },
}));

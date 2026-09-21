import { create } from 'zustand';
import type { Channel, Program, Category, SeriesInfo, MovieInfo } from '../types';
import { getItem, setItem } from '../utils/storage';
import { useAppStore } from './appStore';
import { apiFetch, BackendUnavailableError, clearStoredApiToken, probeBackend, rotateBackendRequestScope, setStoredApiToken } from '../services/api';
import { usesSameOriginApi } from '../utils/server-connection';

const toast = (msg: string) => useAppStore.getState().showToastMessage(msg);

export type InputMode = 'xtream' | 'manual';
export type SyncInterval = 'startup' | '6h' | '12h' | '24h' | 'manual';
export type LoadingPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done' | 'error';
export type BackendConnection = 'unknown' | 'connected' | 'disconnected';

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
  categoriesByType: Record<string, Category[]>;
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
  nextCursor: { sort: number; name: string } | null;
  syncInterval: SyncInterval;
  lastSyncTime: number;
  isCrawling: boolean;
  crawlProgress: string;
  lastCrawlTime: number;
  apiBaseUrl: string;
  backendConnection: BackendConnection;
  backendGeneration: number;
  commercialAutoSkip: boolean;
  _hydrated: boolean;
}

interface RawProgram {
  channelId: string;
  title: string;
  description: string;
  start: string;
  stop: string;
  category: string;
}

interface BackendStatusPayload {
  phase?: LoadingPhase;
  message?: string;
  channelCount?: number;
  lastSyncTime?: number;
  isSyncing?: boolean;
  isCrawling?: boolean;
  crawlProgress?: string;
  lastCrawlTime?: number;
  contentTypeCounts?: Record<string, number>;
}

function parsePrograms(raw: unknown): Program[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawProgram[]).map((program) => ({
    channelId: program.channelId,
    title: program.title,
    description: program.description,
    start: new Date(program.start),
    stop: new Date(program.stop),
    category: program.category,
  }));
}

function configPatch(data: Record<string, unknown>, current: ChannelState): Partial<ChannelState> {
  return {
    inputMode: typeof data.inputMode === 'string' ? data.inputMode as InputMode : current.inputMode,
    playlistUrl: typeof data.playlistUrl === 'string' ? data.playlistUrl : current.playlistUrl,
    epgUrl: typeof data.epgUrl === 'string' ? data.epgUrl : current.epgUrl,
    xtreamCredentials: {
      serverUrl: typeof data.xtreamServer === 'string' ? data.xtreamServer : current.xtreamCredentials.serverUrl,
      username: typeof data.xtreamUsername === 'string' ? data.xtreamUsername : current.xtreamCredentials.username,
      password: typeof data.xtreamPassword === 'string' ? data.xtreamPassword : current.xtreamCredentials.password,
    },
    syncInterval: typeof data.syncInterval === 'string' ? data.syncInterval as SyncInterval : current.syncInterval,
    commercialAutoSkip: typeof data.commercialAutoSkip === 'boolean'
      ? data.commercialAutoSkip
      : current.commercialAutoSkip,
  };
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
// Hosted PWA/Docker builds use relative API paths. A local Tizen widget with an
// empty build-time URL must instead ask the user for its backend address.
export const SAME_ORIGIN = usesSameOriginApi(DEFAULT_SERVER_URL, window.location.protocol);
const INITIAL_API_BASE_URL = SAME_ORIGIN ? '' : getItem<string>(API_BASE_URL_KEY, DEFAULT_SERVER_URL);
/** Check if API is reachable — same-origin always works, remote needs a URL */
function hasApi(apiBaseUrl: string): boolean {
  return SAME_ORIGIN || !!apiBaseUrl;
}

function backendOrigin(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl || window.location.origin, window.location.href).origin;
  } catch {
    return '';
  }
}

interface ChannelActions {
  connectBackend: (url: string, token?: string) => Promise<boolean>;
  fetchCategories: (contentType: string) => Promise<void>;
  fetchChannels: (group?: string, expectedGeneration?: number) => Promise<void>;
  fetchChannelsByIds: (ids: string[]) => Promise<Channel[]>;
  fetchMoreChannels: () => Promise<void>;
  fetchPrograms: (expectedBaseUrl?: string, expectedGeneration?: number) => Promise<void>;
  fetchEpgForStream: (streamId: number) => Promise<Program[]>;
  searchChannels: (query: string, contentType?: string, group?: string) => Promise<Channel[]>;
  fetchSeriesInfo: (seriesId: number) => Promise<SeriesInfo | null>;
  fetchMovieInfo: (vodId: number) => Promise<MovieInfo | null>;
  fetchConfig: (expectedBaseUrl?: string, expectedGeneration?: number) => Promise<void>;
  saveConfig: (config: Record<string, string | boolean>) => Promise<boolean>;
  triggerSync: () => Promise<void>;
  cancelSync: () => void;
  triggerCrawl: () => Promise<void>;
  cancelCrawl: () => void;
  pollStatus: (expectedGeneration?: number) => Promise<void>;
  setSelectedGroup: (group: string) => void;
  setSelectedRegion: (region: string) => void;
  hydrate: () => Promise<void>;
}


let pollInterval: ReturnType<typeof setTimeout> | null = null;
let fetchAbortController: AbortController | null = null;
let connectionAttempt = 0;

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
  categoriesByType: {},
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
  nextCursor: null,
  syncInterval: '24h',
  lastSyncTime: 0,
  isCrawling: false,
  crawlProgress: '',
  lastCrawlTime: 0,
  apiBaseUrl: INITIAL_API_BASE_URL,
  backendConnection: hasApi(INITIAL_API_BASE_URL) ? 'unknown' : 'disconnected',
  backendGeneration: 0,
  commercialAutoSkip: false,
  _hydrated: false,

  connectBackend: async (url: string, token?: string) => {
    const attempt = ++connectionAttempt;
    const active = get();
    const switchingOrigins = backendOrigin(active.apiBaseUrl) !== backendOrigin(url);
    try {
      const status = await probeBackend<BackendStatusPayload>(url);
      const now = Date.now();
      const to = now + 6 * 60 * 60 * 1000;
      const candidateToken = token?.trim();
      const tokenOverride = candidateToken || (switchingOrigins ? null : undefined);
      const [config, programData] = await Promise.all([
        apiFetch<Record<string, unknown>>(url, '/api/config', { cache: 'no-store' }, tokenOverride),
        apiFetch<{ programs?: RawProgram[] }>(
          url,
          `/api/programs?from=${now - 2 * 60 * 60 * 1000}&to=${to}`,
          { cache: 'no-store' },
          tokenOverride,
        ),
      ]);
      if (attempt !== connectionAttempt) return false;

      const current = get();
      const nextGeneration = current.backendGeneration + 1;
      const fallback = switchingOrigins
        ? {
            ...current,
            playlistUrl: '',
            epgUrl: '',
            inputMode: 'xtream' as const,
            xtreamCredentials: { serverUrl: '', username: '', password: '' },
          }
        : current;
      const programs = parsePrograms(programData.programs);

      stopPolling();
      fetchAbortController?.abort();
      fetchAbortController = null;
      rotateBackendRequestScope();
      if (candidateToken) setStoredApiToken(candidateToken);
      else if (switchingOrigins) clearStoredApiToken();
      setItem(API_BASE_URL_KEY, url);
      set({
        ...configPatch(config, fallback),
        apiBaseUrl: url,
        backendConnection: 'connected',
        backendGeneration: nextGeneration,
        error: null,
        _hydrated: true,
        channels: [],
        programs,
        programsByChannel: buildProgramIndex(programs),
        categoriesByType: {},
        groups: ['All'],
        regions: ['All'],
        selectedGroup: 'All',
        selectedRegion: 'All',
        contentTypeCounts: status.contentTypeCounts || {},
        channelCount: status.channelCount || 0,
        channelTotal: 0,
        hasMore: false,
        nextCursor: null,
        isLoading: status.isSyncing === true,
        loadingPhase: status.phase || 'idle',
        loadingMessage: status.message || '',
        lastSyncTime: status.lastSyncTime || 0,
        isCrawling: status.isCrawling === true,
        crawlProgress: status.crawlProgress || '',
        lastCrawlTime: status.lastCrawlTime || 0,
      });

      if (status.isSyncing || status.isCrawling) {
        let pollDelay = status.isSyncing ? 2000 : 5000;
        const schedulePoll = () => {
          pollInterval = setTimeout(() => {
            get().pollStatus(nextGeneration).then(() => {
              const latest = get();
              if (latest.backendGeneration !== nextGeneration) return;
              if (latest.isLoading || latest.isCrawling) {
                pollDelay = Math.min(pollDelay * 1.5, 10000);
                schedulePoll();
              }
            });
          }, pollDelay);
        };
        schedulePoll();
      }
      return true;
    } catch (err) {
      if (attempt !== connectionAttempt) return false;
      const msg = err instanceof Error ? err.message : 'Cannot connect to the StreamVault backend';
      set({ error: msg });
      return false;
    }
  },

  fetchCategories: async (contentType: string) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return;
    try {
      const data = await apiFetch(apiBaseUrl, `/api/categories?type=${encodeURIComponent(contentType)}`);
      if (get().backendGeneration !== backendGeneration) return;
      const list: Category[] = data.categories || [];
      set((state) => ({
        categoriesByType: { ...state.categoriesByType, [contentType]: list },
      }));
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return;
      const msg = err instanceof Error ? err.message : 'Failed to fetch categories';
      set({ error: msg });
    }
  },

  fetchChannels: async (group?: string, expectedGeneration?: number) => {
    const { apiBaseUrl } = get();
    const generation = expectedGeneration ?? get().backendGeneration;
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
      }
      const qs = params.toString();
      const data = await apiFetch(apiBaseUrl, `/api/channels${qs ? '?' + qs : ''}`, { signal });
      if (signal.aborted || get().backendGeneration !== generation) return;
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
        nextCursor: data.nextCursor || null,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (get().backendGeneration !== generation) return;
      const msg = err instanceof Error ? err.message : 'Failed to fetch channels';
      set({ error: msg });
    }
  },

  fetchChannelsByIds: async (ids: string[]) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl) || ids.length === 0) return [];
    try {
      const data = await apiFetch(apiBaseUrl, '/api/channels/by-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (get().backendGeneration !== backendGeneration) return [];
      return (data.channels ?? []) as Channel[];
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return [];
      toast(`Failed to fetch channels: ${err}`);
      return [];
    }
  },

  fetchMoreChannels: async () => {
    const { apiBaseUrl, backendGeneration, channels, channelTotal, hasMore, selectedGroup, nextCursor } = get();
    if (!hasApi(apiBaseUrl) || !hasMore || !nextCursor) return;
    if (!selectedGroup || selectedGroup === 'All') return;
    try {
      const params = new URLSearchParams({
        group: selectedGroup,
        limit: String(PAGE_SIZE),
        cursorSort: String(nextCursor.sort),
        cursorName: nextCursor.name,
      });
      const data = await apiFetch(apiBaseUrl, `/api/channels?${params}`);
      if (get().backendGeneration !== backendGeneration) return;
      const newChannels: Channel[] = data.channels;
      const merged = [...channels, ...newChannels];
      const total: number = data.total ?? channelTotal;
      set({
        channels: merged,
        channelCount: merged.length,
        channelTotal: total,
        hasMore: merged.length < total,
        nextCursor: data.nextCursor || null,
      });
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return;
      const msg = err instanceof Error ? err.message : 'Failed to load more';
      set({ error: msg });
    }
  },

  fetchPrograms: async (expectedBaseUrl?: string, expectedGeneration?: number) => {
    const apiBaseUrl = expectedBaseUrl ?? get().apiBaseUrl;
    const generation = expectedGeneration ?? get().backendGeneration;
    const isCurrent = () => get().backendGeneration === generation;
    if (!hasApi(apiBaseUrl)) return;
    try {
      const now = Date.now();
      const to = now + 6 * 60 * 60 * 1000;
      const data = await apiFetch<{ programs?: RawProgram[] }>(apiBaseUrl, `/api/programs?from=${now - 2 * 60 * 60 * 1000}&to=${to}`);
      if (!isCurrent()) return;
      const programs = parsePrograms(data.programs);
      set({
        programs,
        programsByChannel: buildProgramIndex(programs),
      });
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof Error ? err.message : 'Failed to fetch programs';
      set({ error: msg });
      throw err;
    }
  },

  fetchEpgForStream: async (streamId: number) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return [];
    try {
      const data = await apiFetch(apiBaseUrl, `/api/epg/${streamId}`);
      if (get().backendGeneration !== backendGeneration) return [];
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
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return [];
      toast(`Failed to fetch EPG: ${err}`);
      return [];
    }
  },

  searchChannels: async (query: string, contentType?: string, group?: string) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl) || !query.trim()) return [];
    try {
      const params = new URLSearchParams({ q: query });
      if (contentType) params.set('type', contentType);
      if (group) params.set('group', group);
      const data = await apiFetch(apiBaseUrl, `/api/search?${params}`);
      if (get().backendGeneration !== backendGeneration) return [];
      return data.channels as Channel[];
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return [];
      toast(`Search failed: ${err}`);
      return [];
    }
  },

  fetchSeriesInfo: async (seriesId: number) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return null;
    try {
      const data = await apiFetch(apiBaseUrl, `/api/series/${seriesId}`);
      if (get().backendGeneration !== backendGeneration) return null;
      return data as SeriesInfo;
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return null;
      toast(`Failed to load series: ${err}`);
      return null;
    }
  },

  fetchMovieInfo: async (vodId: number) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return null;
    try {
      const data = await apiFetch(apiBaseUrl, `/api/vod/${vodId}`);
      if (get().backendGeneration !== backendGeneration) return null;
      return data as MovieInfo;
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return null;
      toast(`Failed to load movie: ${err}`);
      return null;
    }
  },

  fetchConfig: async (expectedBaseUrl?: string, expectedGeneration?: number) => {
    const apiBaseUrl = expectedBaseUrl ?? get().apiBaseUrl;
    const generation = expectedGeneration ?? get().backendGeneration;
    const isCurrent = () => get().backendGeneration === generation;
    if (!hasApi(apiBaseUrl)) return;
    try {
      const data = await apiFetch<Record<string, unknown>>(apiBaseUrl, '/api/config');
      if (!isCurrent()) return;
      set(configPatch(data, get()));
    } catch (err) {
      if (!isCurrent()) return;
      toast(`Failed to fetch config: ${err}`);
      throw err;
    }
  },

  saveConfig: async (config: Record<string, string | boolean>) => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return false;
    try {
      await apiFetch(apiBaseUrl, '/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (get().backendGeneration !== backendGeneration) return false;
      // Update local state to match
      if (typeof config.inputMode === 'string') set({ inputMode: config.inputMode as InputMode });
      if (typeof config.playlistUrl === 'string') set({ playlistUrl: config.playlistUrl });
      if (typeof config.epgUrl === 'string') set({ epgUrl: config.epgUrl });
      if (config.xtreamServer !== undefined || config.xtreamUsername !== undefined || config.xtreamPassword !== undefined) {
        const creds = get().xtreamCredentials;
        set({
          xtreamCredentials: {
            serverUrl: typeof config.xtreamServer === 'string' ? config.xtreamServer : creds.serverUrl,
            username: typeof config.xtreamUsername === 'string' ? config.xtreamUsername : creds.username,
            password: typeof config.xtreamPassword === 'string' ? config.xtreamPassword : creds.password,
          },
        });
      }
      if (typeof config.syncInterval === 'string') set({ syncInterval: config.syncInterval as SyncInterval });
      if (config.commercialAutoSkip !== undefined) {
        set({ commercialAutoSkip: config.commercialAutoSkip === true });
      }
      set({ error: null });
      return true;
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return false;
      const msg = err instanceof Error ? err.message : 'Failed to save config';
      set({
        error: msg,
        ...(err instanceof BackendUnavailableError ? { backendConnection: 'disconnected' as const } : {}),
      });
      return false;
    }
  },

  triggerSync: async () => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return;
    set({ isLoading: true, error: null, loadingPhase: 'fetching-playlist', loadingMessage: 'Starting sync...' });
    try {
      await apiFetch(apiBaseUrl, '/api/sync', { method: 'POST' });
      if (get().backendGeneration !== backendGeneration) return;
      // Start polling for status with exponential backoff
      get().pollStatus(backendGeneration);
      let pollDelay = 2000;
      const schedulePoll = () => {
        pollInterval = setTimeout(() => {
          get().pollStatus(backendGeneration).then(() => {
            const current = get();
            if (current.backendGeneration === backendGeneration && current.isLoading) {
              pollDelay = Math.min(pollDelay * 1.5, 10000);
              schedulePoll();
            }
          });
        }, pollDelay);
      };
      schedulePoll();
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return;
      const msg = err instanceof Error ? err.message : 'Failed to start sync';
      set({
        isLoading: false,
        error: msg,
        loadingPhase: 'idle',
        loadingMessage: '',
        ...(err instanceof BackendUnavailableError ? { backendConnection: 'disconnected' as const } : {}),
      });
    }
  },

  cancelSync: () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    stopPolling();
    apiFetch(apiBaseUrl, '/api/sync/cancel', { method: 'POST' }).catch((err) => toast(`Failed to cancel sync: ${err}`));
    set({ isLoading: false, loadingPhase: 'idle', loadingMessage: 'Sync cancelled' });
  },

  triggerCrawl: async () => {
    const { apiBaseUrl, backendGeneration } = get();
    if (!hasApi(apiBaseUrl)) return;
    set({ isCrawling: true, crawlProgress: 'Starting crawl...' });
    try {
      await apiFetch(apiBaseUrl, '/api/crawl', { method: 'POST' });
    } catch (err) {
      if (get().backendGeneration !== backendGeneration) return;
      const msg = err instanceof Error ? err.message : 'Failed to start crawl';
      set({ isCrawling: false, crawlProgress: msg });
    }
  },

  cancelCrawl: () => {
    const { apiBaseUrl } = get();
    if (!hasApi(apiBaseUrl)) return;
    apiFetch(apiBaseUrl, '/api/crawl/cancel', { method: 'POST' }).catch((err) => toast(`Failed to cancel crawl: ${err}`));
    set({ isCrawling: false, crawlProgress: 'Crawl cancelled' });
  },

  pollStatus: async (expectedGeneration?: number) => {
    const { apiBaseUrl } = get();
    const generation = expectedGeneration ?? get().backendGeneration;
    const isCurrent = () => get().backendGeneration === generation;
    if (!hasApi(apiBaseUrl)) return;
    try {
      const status = await apiFetch<BackendStatusPayload>(apiBaseUrl, '/api/status');
      if (!isCurrent()) return;
      set({
        backendConnection: 'connected',
        loadingPhase: status.phase || 'idle',
        loadingMessage: status.message || '',
        channelCount: status.channelCount || 0,
        lastSyncTime: status.lastSyncTime || 0,
        isLoading: status.isSyncing === true,
        isCrawling: status.isCrawling === true,
        crawlProgress: status.crawlProgress || '',
        lastCrawlTime: status.lastCrawlTime || 0,
      });

      if (!status.isSyncing) {
        stopPolling();
        // Sync finished — fetch fresh data
        if (status.phase === 'done') {
          await Promise.all([
            get().fetchChannels(undefined, generation),
            get().fetchPrograms(apiBaseUrl, generation),
          ]);
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      toast(`Status poll failed: ${err}`);
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
    const { apiBaseUrl, backendGeneration } = get();
    if (!SAME_ORIGIN && !apiBaseUrl) {
      set({ backendConnection: 'disconnected', _hydrated: true });
      return;
    }
    const isCurrentBackend = () => get().backendGeneration === backendGeneration;
    try {
      // A configured URL is not a connection. Probe the backend before
      // revealing provider credentials or attempting any other API work.
      const status = await probeBackend(apiBaseUrl);
      if (!isCurrentBackend()) return;

      // Fetch config and programs (NOT all channels — ChannelList loads on demand)
      await Promise.all([
        get().fetchConfig(apiBaseUrl, backendGeneration),
        get().fetchPrograms(apiBaseUrl, backendGeneration),
      ]);
      if (!isCurrentBackend()) return;

      if (status.isSyncing) {
        set({ isLoading: true, loadingPhase: status.phase, loadingMessage: status.message });
        let pollDelay = 2000;
        const schedulePoll = () => {
          pollInterval = setTimeout(() => {
            get().pollStatus(backendGeneration).then(() => {
              const current = get();
              if (current.backendGeneration === backendGeneration && current.isLoading) {
                pollDelay = Math.min(pollDelay * 1.5, 10000);
                schedulePoll();
              }
            });
          }, pollDelay);
        };
        schedulePoll();
      }
      set({
        backendConnection: 'connected',
        error: null,
        lastSyncTime: status.lastSyncTime,
        isCrawling: status.isCrawling,
        crawlProgress: status.crawlProgress || '',
        lastCrawlTime: status.lastCrawlTime || 0,
        contentTypeCounts: status.contentTypeCounts || {},
        _hydrated: true,
      });

      // If crawling, poll for progress
      if (status.isCrawling) {
        const pollCrawl = () => {
          pollInterval = setTimeout(async () => {
            await get().pollStatus(backendGeneration);
            const current = get();
            if (current.backendGeneration === backendGeneration && current.isCrawling) pollCrawl();
          }, 5000);
        };
        pollCrawl();
      }
    } catch (err) {
      if (!isCurrentBackend()) return;
      const msg = err instanceof Error ? err.message : 'Cannot connect to server';
      set({ error: msg, backendConnection: 'disconnected', _hydrated: true });
    }
  },
}));

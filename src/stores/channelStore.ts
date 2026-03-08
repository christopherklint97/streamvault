import { create } from 'zustand';
import type { Channel, Program } from '../types';
import { parseM3U } from '../services/m3u-parser';
import { fetchEPG } from '../services/epg-service';
import { getItem, setItem } from '../utils/storage';

export type InputMode = 'xtream' | 'manual';
export type SyncInterval = 'startup' | '6h' | '12h' | '24h' | 'manual';
export type LoadingPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done';

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

function buildXtreamUrls(creds: XtreamCredentials): { playlistUrl: string; epgUrl: string } {
  let base = creds.serverUrl.trim();
  // Remove trailing slash
  if (base.endsWith('/')) base = base.slice(0, -1);
  const playlistUrl = `${base}/get.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&type=m3u&output=mpegts`;
  const epgUrl = `${base}/xmltv.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  return { playlistUrl, epgUrl };
}

interface ChannelActions {
  loadPlaylist: (url: string) => Promise<void>;
  setChannels: (channels: Channel[]) => void;
  loadEPG: (url: string) => Promise<void>;
  setSelectedGroup: (group: string) => void;
  setSelectedRegion: (region: string) => void;
  setPlaylistUrl: (url: string) => void;
  setEpgUrl: (url: string) => void;
  setInputMode: (mode: InputMode) => void;
  setXtreamCredentials: (creds: XtreamCredentials) => void;
  loadFromXtream: () => Promise<void>;
  loadAll: (playlistUrl: string, epgUrl: string) => Promise<void>;
  setSyncInterval: (interval: SyncInterval) => void;
  checkAndSync: () => Promise<void>;
  syncNow: () => Promise<void>;
}

const PLAYLIST_URL_KEY = 'streamvault_playlist_url';
const EPG_URL_KEY = 'streamvault_epg_url';
const INPUT_MODE_KEY = 'streamvault_input_mode';
const XTREAM_CREDS_KEY = 'streamvault_xtream_creds';
const CACHED_CHANNELS_KEY = 'streamvault_cached_channels';
const CACHED_PROGRAMS_KEY = 'streamvault_cached_programs';
const SYNC_INTERVAL_KEY = 'streamvault_sync_interval';
const LAST_SYNC_KEY = 'streamvault_last_sync';

function extractGroupsAndRegions(channels: Channel[]): { groups: string[]; regions: string[] } {
  const groups = Array.from(new Set(channels.map((ch) => ch.group).filter(Boolean)));
  groups.sort();
  groups.unshift('All');
  const regions = Array.from(new Set(channels.map((ch) => ch.region).filter(Boolean)));
  regions.sort();
  regions.unshift('All');
  return { groups, regions };
}

// Load cached channels on init
function loadCachedChannels(): Channel[] {
  return getItem<Channel[]>(CACHED_CHANNELS_KEY, []);
}

function loadCachedPrograms(): Program[] {
  const raw = getItem<Array<{ channelId: string; title: string; description: string; start: string; stop: string; category: string }>>(CACHED_PROGRAMS_KEY, []);
  // Rehydrate Date objects
  return raw.map((p) => ({
    ...p,
    start: new Date(p.start),
    stop: new Date(p.stop),
  }));
}

const cachedChannels = loadCachedChannels();
const cachedPrograms = loadCachedPrograms();
const cachedGroupsRegions = extractGroupsAndRegions(cachedChannels);

export const useChannelStore = create<ChannelState & ChannelActions>()((set, get) => ({
  channels: cachedChannels,
  programs: cachedPrograms,
  programsByChannel: buildProgramIndex(cachedPrograms),
  groups: cachedGroupsRegions.groups,
  regions: cachedGroupsRegions.regions,
  selectedGroup: 'All',
  selectedRegion: 'All',
  isLoading: false,
  error: null,
  playlistUrl: getItem<string>(PLAYLIST_URL_KEY, ''),
  epgUrl: getItem<string>(EPG_URL_KEY, ''),
  inputMode: getItem<InputMode>(INPUT_MODE_KEY, 'xtream'),
  xtreamCredentials: getItem<XtreamCredentials>(XTREAM_CREDS_KEY, { serverUrl: '', username: '', password: '' }),
  loadingPhase: 'idle',
  loadingMessage: '',
  channelCount: cachedChannels.length,
  syncInterval: getItem<SyncInterval>(SYNC_INTERVAL_KEY, '24h'),
  lastSyncTime: getItem<number>(LAST_SYNC_KEY, 0),

  loadPlaylist: async (url: string) => {
    set({ isLoading: true, error: null, loadingPhase: 'fetching-playlist', loadingMessage: 'Downloading playlist...' });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.status} ${response.statusText}`);
      }
      set({ loadingPhase: 'parsing-playlist', loadingMessage: 'Downloading playlist data...' });
      const text = await response.text();
      set({ loadingMessage: 'Parsing channels...' });
      const channels = parseM3U(text);
      const { groups, regions } = extractGroupsAndRegions(channels);

      set({
        channels,
        groups,
        regions,
        isLoading: false,
        error: null,
        playlistUrl: url,
        loadingPhase: 'done',
        loadingMessage: `Loaded ${channels.length} channels`,
        channelCount: channels.length,
      });

      setItem(PLAYLIST_URL_KEY, url);
      setItem(CACHED_CHANNELS_KEY, channels);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load playlist';
      set({ isLoading: false, error: message, loadingPhase: 'idle', loadingMessage: '' });
    }
  },

  setChannels: (channels: Channel[]) => {
    const { groups, regions } = extractGroupsAndRegions(channels);
    set({ channels, groups, regions });
  },

  loadEPG: async (url: string) => {
    set({ isLoading: true, error: null, loadingPhase: 'fetching-epg', loadingMessage: 'Downloading EPG data...' });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
      }
      set({ loadingPhase: 'parsing-epg', loadingMessage: 'Parsing program guide...' });
      const text = await response.text();
      const programs = fetchEPG(text);

      set({
        programs,
        programsByChannel: buildProgramIndex(programs),
        isLoading: false,
        error: null,
        epgUrl: url,
        loadingPhase: 'done',
        loadingMessage: `Loaded ${programs.length} programs`,
      });

      setItem(EPG_URL_KEY, url);
      setItem(CACHED_PROGRAMS_KEY, programs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load EPG';
      set({ isLoading: false, error: message, loadingPhase: 'idle', loadingMessage: '' });
    }
  },

  setSelectedGroup: (group: string) => set({ selectedGroup: group }),
  setSelectedRegion: (region: string) => set({ selectedRegion: region }),

  setPlaylistUrl: (url: string) => {
    set({ playlistUrl: url });
    setItem(PLAYLIST_URL_KEY, url);
  },

  setEpgUrl: (url: string) => {
    set({ epgUrl: url });
    setItem(EPG_URL_KEY, url);
  },

  setInputMode: (mode: InputMode) => {
    set({ inputMode: mode });
    setItem(INPUT_MODE_KEY, mode);
  },

  setXtreamCredentials: (creds: XtreamCredentials) => {
    set({ xtreamCredentials: creds });
    setItem(XTREAM_CREDS_KEY, creds);
  },

  loadFromXtream: async () => {
    const { xtreamCredentials } = get();
    if (!xtreamCredentials.serverUrl || !xtreamCredentials.username || !xtreamCredentials.password) {
      set({ error: 'Please fill in all Xtream Codes fields' });
      return;
    }
    const { playlistUrl, epgUrl } = buildXtreamUrls(xtreamCredentials);
    set({ playlistUrl, epgUrl });
    setItem(PLAYLIST_URL_KEY, playlistUrl);
    setItem(EPG_URL_KEY, epgUrl);
    setItem(XTREAM_CREDS_KEY, xtreamCredentials);
    await get().loadAll(playlistUrl, epgUrl);
  },

  loadAll: async (playlistUrl: string, epgUrl: string) => {
    // Load playlist
    set({ isLoading: true, error: null, loadingPhase: 'fetching-playlist', loadingMessage: 'Downloading playlist...' });
    try {
      const playlistResponse = await fetch(playlistUrl);
      if (!playlistResponse.ok) {
        throw new Error(`Failed to fetch playlist: ${playlistResponse.status} ${playlistResponse.statusText}`);
      }
      set({ loadingPhase: 'parsing-playlist', loadingMessage: 'Downloading playlist data...' });
      const playlistText = await playlistResponse.text();
      set({ loadingMessage: 'Parsing channels...' });
      const channels = parseM3U(playlistText);
      const { groups, regions } = extractGroupsAndRegions(channels);

      set({
        channels,
        groups,
        regions,
        playlistUrl,
        channelCount: channels.length,
        loadingMessage: `Parsed ${channels.length} channels. Loading EPG...`,
      });
      setItem(PLAYLIST_URL_KEY, playlistUrl);
      setItem(CACHED_CHANNELS_KEY, channels);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load playlist';
      set({ isLoading: false, error: message, loadingPhase: 'idle', loadingMessage: '' });
      return;
    }

    // Load EPG
    set({ loadingPhase: 'fetching-epg', loadingMessage: 'Downloading EPG data...' });
    try {
      const epgResponse = await fetch(epgUrl);
      if (!epgResponse.ok) {
        throw new Error(`Failed to fetch EPG: ${epgResponse.status} ${epgResponse.statusText}`);
      }
      set({ loadingPhase: 'parsing-epg', loadingMessage: 'Parsing program guide...' });
      const epgText = await epgResponse.text();
      const programs = fetchEPG(epgText);

      const now = Date.now();
      set({
        programs,
        programsByChannel: buildProgramIndex(programs),
        isLoading: false,
        error: null,
        epgUrl,
        loadingPhase: 'done',
        loadingMessage: `Sync complete: ${get().channels.length} channels, ${programs.length} programs`,
        lastSyncTime: now,
      });
      setItem(EPG_URL_KEY, epgUrl);
      setItem(CACHED_PROGRAMS_KEY, programs);
      setItem(LAST_SYNC_KEY, now);
    } catch (err) {
      // EPG failed but playlist succeeded — partial success
      const message = err instanceof Error ? err.message : 'Failed to load EPG';
      const now = Date.now();
      set({
        isLoading: false,
        error: `Channels loaded but EPG failed: ${message}`,
        loadingPhase: 'done',
        loadingMessage: `Loaded ${get().channels.length} channels (EPG failed)`,
        lastSyncTime: now,
      });
      setItem(LAST_SYNC_KEY, now);
    }
  },

  setSyncInterval: (interval: SyncInterval) => {
    set({ syncInterval: interval });
    setItem(SYNC_INTERVAL_KEY, interval);
  },

  checkAndSync: async () => {
    const { syncInterval, lastSyncTime, playlistUrl, epgUrl, isLoading } = get();
    if (isLoading || !playlistUrl || syncInterval === 'manual') return;

    const now = Date.now();
    let intervalMs = 0;
    switch (syncInterval) {
      case 'startup': intervalMs = 0; break; // always sync on startup
      case '6h': intervalMs = 6 * 60 * 60 * 1000; break;
      case '12h': intervalMs = 12 * 60 * 60 * 1000; break;
      case '24h': intervalMs = 24 * 60 * 60 * 1000; break;
    }

    if (syncInterval === 'startup' || (now - lastSyncTime) >= intervalMs) {
      await get().loadAll(playlistUrl, epgUrl);
    }
  },

  syncNow: async () => {
    const { playlistUrl, epgUrl, isLoading } = get();
    if (isLoading) return;
    if (!playlistUrl) {
      set({ error: 'No playlist URL configured' });
      return;
    }
    await get().loadAll(playlistUrl, epgUrl);
  },
}));

import { create } from 'zustand';
import type { Channel, Program } from '../types';
import { parseM3U } from '../services/m3u-parser';
import { fetchEPG } from '../services/epg-service';
import { getItem, setItem } from '../utils/storage';

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
  // Sort each channel's programs by start time
  for (const list of index.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  return index;
}

interface ChannelActions {
  loadPlaylist: (url: string) => Promise<void>;
  setChannels: (channels: Channel[]) => void;
  loadEPG: (url: string) => Promise<void>;
  setSelectedGroup: (group: string) => void;
  setSelectedRegion: (region: string) => void;
  setPlaylistUrl: (url: string) => void;
  setEpgUrl: (url: string) => void;
}

const PLAYLIST_URL_KEY = 'streamvault_playlist_url';
const EPG_URL_KEY = 'streamvault_epg_url';

export const useChannelStore = create<ChannelState & ChannelActions>()((set) => ({
  channels: [],
  programs: [],
  programsByChannel: new Map(),
  groups: [],
  regions: [],
  selectedGroup: 'All',
  selectedRegion: 'All',
  isLoading: false,
  error: null,
  playlistUrl: getItem<string>(PLAYLIST_URL_KEY, ''),
  epgUrl: getItem<string>(EPG_URL_KEY, ''),

  loadPlaylist: async (url: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const channels = parseM3U(text);

      const groups = Array.from(new Set(channels.map((ch) => ch.group).filter(Boolean)));
      groups.sort();
      groups.unshift('All');

      const regions = Array.from(new Set(channels.map((ch) => ch.region).filter(Boolean)));
      regions.sort();
      regions.unshift('All');

      set({
        channels,
        groups,
        regions,
        isLoading: false,
        error: null,
        playlistUrl: url,
      });

      setItem(PLAYLIST_URL_KEY, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load playlist';
      set({ isLoading: false, error: message });
    }
  },

  setChannels: (channels: Channel[]) => {
    const groups = Array.from(new Set(channels.map((ch) => ch.group).filter(Boolean)));
    groups.sort();
    groups.unshift('All');

    const regions = Array.from(new Set(channels.map((ch) => ch.region).filter(Boolean)));
    regions.sort();
    regions.unshift('All');

    set({ channels, groups, regions });
  },

  loadEPG: async (url: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const programs = fetchEPG(text);

      set({
        programs,
        programsByChannel: buildProgramIndex(programs),
        isLoading: false,
        error: null,
        epgUrl: url,
      });

      setItem(EPG_URL_KEY, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load EPG';
      set({ isLoading: false, error: message });
    }
  },

  setSelectedGroup: (group: string) => {
    set({ selectedGroup: group });
  },

  setSelectedRegion: (region: string) => {
    set({ selectedRegion: region });
  },

  setPlaylistUrl: (url: string) => {
    set({ playlistUrl: url });
    setItem(PLAYLIST_URL_KEY, url);
  },

  setEpgUrl: (url: string) => {
    set({ epgUrl: url });
    setItem(EPG_URL_KEY, url);
  },
}));

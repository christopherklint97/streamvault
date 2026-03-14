import { create } from 'zustand';
import type { Channel, FavoriteList } from '../types';
import { getItem, setItem } from '../utils/storage';

const FAVORITES_KEY = 'streamvault_favorites';
const LISTS_KEY = 'streamvault_favorite_lists';

interface FavoritesState {
  favoriteIds: Set<string>;
  lists: FavoriteList[];
}

interface FavoritesActions {
  toggleFavorite: (channelId: string) => void;
  isFavorite: (channelId: string) => boolean;
  getFavoriteChannels: (allChannels: Channel[]) => Channel[];
  createList: (name: string) => string;
  renameList: (listId: string, name: string) => void;
  deleteList: (listId: string) => void;
  addToList: (listId: string, channelId: string) => void;
  removeFromList: (listId: string, channelId: string) => void;
  isInList: (listId: string, channelId: string) => boolean;
  getListChannels: (listId: string, allChannels: Channel[]) => Channel[];
}

function loadFavorites(): Set<string> {
  const stored = getItem<string[]>(FAVORITES_KEY, []);
  return new Set(stored);
}

function persistFavorites(ids: Set<string>): void {
  setItem(FAVORITES_KEY, Array.from(ids));
}

function loadLists(): FavoriteList[] {
  return getItem<FavoriteList[]>(LISTS_KEY, []);
}

function persistLists(lists: FavoriteList[]): void {
  setItem(LISTS_KEY, lists);
}

let nextId = Date.now();

export const useFavoritesStore = create<FavoritesState & FavoritesActions>()((set, get) => ({
  favoriteIds: loadFavorites(),
  lists: loadLists(),

  toggleFavorite: (channelId: string) => {
    const { favoriteIds } = get();
    const next = new Set(favoriteIds);

    if (next.has(channelId)) {
      next.delete(channelId);
    } else {
      next.add(channelId);
    }

    set({ favoriteIds: next });
    persistFavorites(next);
  },

  isFavorite: (channelId: string) => {
    return get().favoriteIds.has(channelId);
  },

  getFavoriteChannels: (allChannels: Channel[]) => {
    const { favoriteIds } = get();
    return allChannels.filter((ch) => favoriteIds.has(ch.id));
  },

  createList: (name: string) => {
    const id = `list_${++nextId}`;
    const newList: FavoriteList = { id, name, channelIds: [] };
    const lists = [...get().lists, newList];
    set({ lists });
    persistLists(lists);
    return id;
  },

  renameList: (listId: string, name: string) => {
    const lists = get().lists.map(l => l.id === listId ? { ...l, name } : l);
    set({ lists });
    persistLists(lists);
  },

  deleteList: (listId: string) => {
    const lists = get().lists.filter(l => l.id !== listId);
    set({ lists });
    persistLists(lists);
  },

  addToList: (listId: string, channelId: string) => {
    const lists = get().lists.map(l => {
      if (l.id !== listId || l.channelIds.includes(channelId)) return l;
      return { ...l, channelIds: [...l.channelIds, channelId] };
    });
    set({ lists });
    persistLists(lists);
  },

  removeFromList: (listId: string, channelId: string) => {
    const lists = get().lists.map(l => {
      if (l.id !== listId) return l;
      return { ...l, channelIds: l.channelIds.filter(id => id !== channelId) };
    });
    set({ lists });
    persistLists(lists);
  },

  isInList: (listId: string, channelId: string) => {
    const list = get().lists.find(l => l.id === listId);
    return list ? list.channelIds.includes(channelId) : false;
  },

  getListChannels: (listId: string, allChannels: Channel[]) => {
    const list = get().lists.find(l => l.id === listId);
    if (!list) return [];
    const idSet = new Set(list.channelIds);
    return allChannels.filter(ch => idSet.has(ch.id));
  },
}));

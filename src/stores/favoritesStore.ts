import { create } from 'zustand';
import type { Channel } from '../types';
import { getItem, setItem } from '../utils/storage';

const FAVORITES_KEY = 'streamvault_favorites';

interface FavoritesState {
  favoriteIds: Set<string>;
}

interface FavoritesActions {
  toggleFavorite: (channelId: string) => void;
  isFavorite: (channelId: string) => boolean;
  getFavoriteChannels: (allChannels: Channel[]) => Channel[];
}

function loadFavorites(): Set<string> {
  const stored = getItem<string[]>(FAVORITES_KEY, []);
  return new Set(stored);
}

function persistFavorites(ids: Set<string>): void {
  setItem(FAVORITES_KEY, Array.from(ids));
}

export const useFavoritesStore = create<FavoritesState & FavoritesActions>()((set, get) => ({
  favoriteIds: loadFavorites(),

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
}));

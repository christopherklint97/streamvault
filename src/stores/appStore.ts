import { create } from 'zustand';
import type { View, Channel } from '../types';

/** Persisted search/filter state for each content-type browse view */
export interface BrowseState {
  searchQuery: string;
  selectedGroup: string | null;
}

interface AppState {
  currentView: View;
  viewStack: View[];
  selectedGroup: string | null;
  selectedSeries: Channel | null;
  selectedMovie: Channel | null;
  showExitDialog: boolean;
  showToast: boolean;
  toastMessage: string;
  /** Search/filter state keyed by view name (channels, movies, series) */
  browseStates: Record<string, BrowseState>;
}

interface AppActions {
  navigate: (view: View) => void;
  navigateToSeries: (series: Channel) => void;
  navigateToMovie: (movie: Channel) => void;
  goBack: () => void;
  selectGroup: (group: string) => void;
  clearGroup: () => void;
  showExitConfirm: () => void;
  hideExitConfirm: () => void;
  showToastMessage: (msg: string) => void;
  setBrowseState: (view: string, state: Partial<BrowseState>) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Push a browser history entry so the back button triggers popstate */
function pushState(view: View, group?: string | null) {
  history.pushState({ view, group: group || null }, '');
}

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  currentView: 'home',
  viewStack: [],
  selectedGroup: null,
  selectedSeries: null,
  selectedMovie: null,
  showExitDialog: false,
  showToast: false,
  toastMessage: '',
  browseStates: {},

  navigate: (view: View) => {
    const { currentView, viewStack } = get();
    pushState(view);
    set({
      viewStack: [...viewStack, currentView],
      currentView: view,
      selectedGroup: null,
      showExitDialog: false,
    });
  },

  navigateToSeries: (series: Channel) => {
    const { currentView, viewStack } = get();
    pushState('seriesDetail');
    set({
      viewStack: [...viewStack, currentView],
      currentView: 'seriesDetail',
      selectedSeries: series,
      showExitDialog: false,
    });
  },

  navigateToMovie: (movie: Channel) => {
    const { currentView, viewStack } = get();
    pushState('movieDetail');
    set({
      viewStack: [...viewStack, currentView],
      currentView: 'movieDetail',
      selectedMovie: movie,
      showExitDialog: false,
    });
  },

  selectGroup: (group: string) => {
    pushState(get().currentView, group);
    set({ selectedGroup: group });
  },

  clearGroup: () => {
    set({ selectedGroup: null });
  },

  goBack: () => {
    const { currentView, viewStack, selectedGroup } = get();

    // If we have a view stack, pop from it
    if (viewStack.length > 0) {
      const newStack = [...viewStack];
      const prevView = newStack.pop()!;
      set({
        viewStack: newStack,
        currentView: prevView,
        selectedSeries: currentView === 'seriesDetail' ? null : get().selectedSeries,
        selectedMovie: currentView === 'movieDetail' ? null : get().selectedMovie,
        showExitDialog: false,
      });
      return;
    }

    // If inside a group, go back to group list
    if (selectedGroup) {
      set({ selectedGroup: null });
      return;
    }

    // From a content view, go home
    if (currentView !== 'home') {
      set({
        currentView: 'home',
        viewStack: [],
        selectedGroup: null,
        showExitDialog: false,
      });
      return;
    }

    // Already on home - show exit dialog
    set({ showExitDialog: true });
  },

  showExitConfirm: () => {
    set({ showExitDialog: true });
  },

  hideExitConfirm: () => {
    set({ showExitDialog: false });
  },

  showToastMessage: (msg: string) => {
    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    set({ showToast: true, toastMessage: msg });

    toastTimer = setTimeout(() => {
      set({ showToast: false, toastMessage: '' });
      toastTimer = null;
    }, 3000);
  },

  setBrowseState: (view: string, partial: Partial<BrowseState>) => {
    const { browseStates } = get();
    const current = browseStates[view] || { searchQuery: '', selectedGroup: null };
    set({
      browseStates: {
        ...browseStates,
        [view]: { ...current, ...partial },
      },
    });
  },
}));

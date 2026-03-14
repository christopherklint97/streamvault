import { create } from 'zustand';
import type { View, Channel } from '../types';

interface AppState {
  currentView: View;
  previousView: View | null;
  selectedGroup: string | null;
  selectedSeries: Channel | null;
  showExitDialog: boolean;
  showToast: boolean;
  toastMessage: string;
}

interface AppActions {
  navigate: (view: View) => void;
  navigateToSeries: (series: Channel) => void;
  goBack: () => void;
  selectGroup: (group: string) => void;
  clearGroup: () => void;
  showExitConfirm: () => void;
  hideExitConfirm: () => void;
  showToastMessage: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Push a browser history entry so the back button triggers popstate */
function pushState(view: View, group?: string | null) {
  history.pushState({ view, group: group || null }, '');
}

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  currentView: 'home',
  previousView: null,
  selectedGroup: null,
  selectedSeries: null,
  showExitDialog: false,
  showToast: false,
  toastMessage: '',

  navigate: (view: View) => {
    const { currentView } = get();
    pushState(view);
    set({
      previousView: currentView,
      currentView: view,
      selectedGroup: null,
      showExitDialog: false,
    });
  },

  navigateToSeries: (series: Channel) => {
    const { currentView } = get();
    pushState('seriesDetail');
    set({
      previousView: currentView,
      currentView: 'seriesDetail',
      selectedSeries: series,
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
    const { currentView, previousView, selectedGroup } = get();

    // From player or seriesDetail, go back to previous view
    if ((currentView === 'player' || currentView === 'seriesDetail') && previousView) {
      set({
        currentView: previousView,
        previousView: null,
        selectedSeries: currentView === 'seriesDetail' ? null : get().selectedSeries,
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
        previousView: null,
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
}));

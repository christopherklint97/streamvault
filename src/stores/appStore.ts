import { create } from 'zustand';
import type { View } from '../types';

interface AppState {
  currentView: View;
  previousView: View | null;
  selectedGroup: string | null;
  showExitDialog: boolean;
  showToast: boolean;
  toastMessage: string;
}

interface AppActions {
  navigate: (view: View) => void;
  goBack: () => void;
  selectGroup: (group: string) => void;
  clearGroup: () => void;
  showExitConfirm: () => void;
  hideExitConfirm: () => void;
  showToastMessage: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  currentView: 'home',
  previousView: null,
  selectedGroup: null,
  showExitDialog: false,
  showToast: false,
  toastMessage: '',

  navigate: (view: View) => {
    const { currentView } = get();
    set({
      previousView: currentView,
      currentView: view,
      selectedGroup: null,
      showExitDialog: false,
    });
  },

  selectGroup: (group: string) => {
    set({ selectedGroup: group });
  },

  clearGroup: () => {
    set({ selectedGroup: null });
  },

  goBack: () => {
    const { currentView, previousView, selectedGroup } = get();

    // From player, go back to previous view
    if (currentView === 'player' && previousView) {
      set({
        currentView: previousView,
        previousView: null,
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

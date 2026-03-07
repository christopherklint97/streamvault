import { create } from 'zustand';
import type { View } from '../types';

interface AppState {
  currentView: View;
  previousView: View | null;
  showExitDialog: boolean;
  showToast: boolean;
  toastMessage: string;
}

interface AppActions {
  navigate: (view: View) => void;
  goBack: () => void;
  showExitConfirm: () => void;
  hideExitConfirm: () => void;
  showToastMessage: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  currentView: 'home',
  previousView: null,
  showExitDialog: false,
  showToast: false,
  toastMessage: '',

  navigate: (view: View) => {
    const { currentView } = get();
    set({
      previousView: currentView,
      currentView: view,
      showExitDialog: false,
    });
  },

  goBack: () => {
    const { currentView, previousView } = get();

    if (currentView === 'player' && previousView) {
      set({
        currentView: previousView,
        previousView: null,
        showExitDialog: false,
      });
      return;
    }

    if (currentView !== 'home') {
      set({
        currentView: previousView ?? 'home',
        previousView: null,
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

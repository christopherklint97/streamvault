import { useAppStore } from './appStore';
import { resetPlayerBackendState } from './playerStore';
import { resetRecordingBackendState } from './recordingStore';
import { stopActivePlayback } from '../hooks/usePlayer';
import { resetFavoritesBackendState } from './favoritesStore';
import { clearBackendWatchState } from '../services/channel-service';

export function resetBackendScopedStores(clearPersistentData = false): void {
  const { currentView } = useAppStore.getState();

  try {
    stopActivePlayback();
  } catch {
    // Store cleanup must still complete if a platform transport throws.
  } finally {
    resetPlayerBackendState();
    resetRecordingBackendState();
    if (clearPersistentData) {
      resetFavoritesBackendState();
      clearBackendWatchState();
    }
    useAppStore.setState({
      viewStack: [],
      selectedGroup: null,
      selectedSeries: null,
      selectedMovie: null,
      selectedRecordingId: null,
      navigationBlocker: null,
      browseStates: {},
      visitedViews: { [currentView]: true },
    });
  }
}

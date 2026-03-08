import { useEffect, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { useChannelStore } from './stores/channelStore';
import { useFavoritesStore } from './stores/favoritesStore';
import { useRemoteKeys } from './hooks/useRemoteKeys';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { KEY_CODES } from './utils/keys';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import ExitDialog from './components/ExitDialog';
import Player from './components/Player';
import ChannelList from './components/ChannelList';
import EPGGrid from './components/EPGGrid';
import Home from './pages/Home';
import Settings from './pages/Settings';

function AppContent() {
  const currentView = useAppStore((s) => s.currentView);
  const channels = useChannelStore((s) => s.channels);
  const playlistUrl = useChannelStore((s) => s.playlistUrl);
  const isLoading = useChannelStore((s) => s.isLoading);
  const loadingMessage = useChannelStore((s) => s.loadingMessage);
  const loadingPhase = useChannelStore((s) => s.loadingPhase);
  const favoriteIds = useFavoritesStore((s) => s.favoriteIds);
  const { isOnline } = useNetworkStatus();

  useRemoteKeys();

  // Register Tizen remote keys and set initial focus
  useEffect(() => {
    // Register non-default keys on Tizen
    if (typeof tizen !== 'undefined' && tizen.tvinputdevice) {
      const keysToRegister = [
        'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
        'ChannelUp', 'ChannelDown', 'Info', 'ColorF0Red', 'ColorF1Green',
        'ColorF2Yellow', 'ColorF3Blue', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      ];
      for (const key of keysToRegister) {
        try { tizen.tvinputdevice.registerKey(key); } catch { /* ignore */ }
      }
    }

    // Set initial focus on first sidebar item
    requestAnimationFrame(() => {
      const firstItem = document.querySelector('.sidebar-item') as HTMLElement | null;
      firstItem?.focus();
    });
  }, []);

  const checkAndSync = useChannelStore((s) => s.checkAndSync);

  // Auto-sync on mount — runs in background without blocking navigation
  useEffect(() => {
    if (playlistUrl) {
      checkAndSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the view changes, push focus into the new content area
  // so the new FocusZone (or EPGGrid) receives focus and activates
  useEffect(() => {
    if (currentView === 'player') return;
    // Give React a frame to render the new view
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      // Only push focus if it's lost (body/null/detached) — don't steal from sidebar
      const isSidebarFocused = active && (active as HTMLElement).closest?.('.sidebar');
      if (isSidebarFocused) return;

      const container = document.querySelector('.app__content > [tabindex]') as HTMLElement | null;
      if (container) {
        container.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [currentView]);

  // Handle LEFT key on main content to return focus to sidebar
  const handleMainKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.keyCode === KEY_CODES.LEFT) {
      // If LEFT bubbled up here, no component consumed it — go to sidebar
      e.preventDefault();
      const activeItem = document.querySelector('.sidebar-item--active') as HTMLElement | null;
      const fallback = document.querySelector('.sidebar-item') as HTMLElement | null;
      (activeItem ?? fallback)?.focus();
    }
  }, []);

  // Merge favorite status into channels
  const channelsWithFavorites = channels.map((ch) => ({
    ...ch,
    isFavorite: favoriteIds.has(ch.id),
  }));

  const renderView = () => {
    switch (currentView) {
      case 'home':
        return <Home />;
      case 'channels':
        return <ChannelList channels={channelsWithFavorites.filter(ch => ch.contentType === 'livetv')} />;
      case 'movies':
        return <ChannelList channels={channelsWithFavorites.filter(ch => ch.contentType === 'movies')} />;
      case 'series':
        return <ChannelList channels={channelsWithFavorites.filter(ch => ch.contentType === 'series')} />;
      case 'guide':
        return <EPGGrid />;
      case 'player':
        return <Player />;
      case 'settings':
        return <Settings />;
      default:
        return <Home />;
    }
  };

  return (
    <div className="app">
      {!isOnline && (
        <div className="app__offline-banner">
          No network connection. Some features may be unavailable.
        </div>
      )}
      {isLoading && currentView !== 'settings' && currentView !== 'player' && (
        <div className="app__loading-banner">
          <div className="app__loading-bar">
            <div
              className="app__loading-fill"
              style={{
                width: loadingPhase === 'fetching-playlist' ? '15%'
                  : loadingPhase === 'parsing-playlist' ? '40%'
                  : loadingPhase === 'fetching-epg' ? '60%'
                  : loadingPhase === 'parsing-epg' ? '85%'
                  : loadingPhase === 'done' ? '100%'
                  : '0%',
              }}
            />
          </div>
          <span className="app__loading-text">{loadingMessage}</span>
        </div>
      )}
      {currentView !== 'player' && <Sidebar />}
      <main
        className={`app__content${currentView === 'player' ? ' app__content--fullscreen' : ''}`}
        onKeyDown={currentView !== 'player' ? handleMainKeyDown : undefined}
      >
        {renderView()}
      </main>
      <Toast />
      <ExitDialog />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

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
  const loadPlaylist = useChannelStore((s) => s.loadPlaylist);
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
        try { tizen.tvinputdevice.registerKey(key); } catch (_) { /* ignore */ }
      }
    }

    // Set initial focus on first sidebar item
    requestAnimationFrame(() => {
      const firstItem = document.querySelector('.sidebar-item') as HTMLElement | null;
      firstItem?.focus();
    });
  }, []);

  // Auto-load channels on mount if URL exists
  useEffect(() => {
    if (playlistUrl && channels.length === 0) {
      loadPlaylist(playlistUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

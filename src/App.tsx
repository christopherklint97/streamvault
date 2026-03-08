import { useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from './stores/appStore';
import { useChannelStore } from './stores/channelStore';
import { useRemoteKeys } from './hooks/useRemoteKeys';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { KEY_CODES } from './utils/keys';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import ExitDialog from './components/ExitDialog';
import Player from './components/Player';
import GroupList from './components/GroupList';
import ChannelList from './components/ChannelList';
import Home from './pages/Home';
import Settings from './pages/Settings';

function AppContent() {
  const currentView = useAppStore((s) => s.currentView);
  const selectedGroup = useAppStore((s) => s.selectedGroup);
  const channels = useChannelStore((s) => s.channels);
  const isLoading = useChannelStore((s) => s.isLoading);
  const loadingMessage = useChannelStore((s) => s.loadingMessage);
  const loadingPhase = useChannelStore((s) => s.loadingPhase);
  const cancelSync = useChannelStore((s) => s.cancelSync);
  const hydrate = useChannelStore((s) => s.hydrate);
  const { isOnline } = useNetworkStatus();

  useRemoteKeys();

  // Register Tizen remote keys and set initial focus
  useEffect(() => {
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

    requestAnimationFrame(() => {
      const firstItem = document.querySelector('.sidebar-item') as HTMLElement | null;
      firstItem?.focus();
    });
  }, []);

  // Hydrate from server on startup
  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle LEFT key on main content to return focus to sidebar
  const handleMainKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.keyCode === KEY_CODES.LEFT) {
      e.preventDefault();
      const activeItem = document.querySelector('.sidebar-item--active') as HTMLElement | null;
      const fallback = document.querySelector('.sidebar-item') as HTMLElement | null;
      (activeItem ?? fallback)?.focus();
    }
  }, []);

  // Memoize filtered channels by content type — single filter pass, stable reference
  const filteredChannels = useMemo(() => {
    const typeMap: Record<string, string> = { channels: 'livetv', movies: 'movies', series: 'series' };
    const type = typeMap[currentView];
    if (!type) return channels;
    return channels.filter(ch => ch.contentType === type);
  }, [channels, currentView]);

  const renderView = () => {
    switch (currentView) {
      case 'home':
        return <Home />;
      case 'channels':
        if (selectedGroup) {
          return <ChannelList channels={filteredChannels} groupName={selectedGroup} />;
        }
        return <GroupList contentType="livetv" />;
      case 'movies':
        if (selectedGroup) {
          return <ChannelList channels={filteredChannels} groupName={selectedGroup} />;
        }
        return <GroupList contentType="movies" />;
      case 'series':
        if (selectedGroup) {
          return <ChannelList channels={filteredChannels} groupName={selectedGroup} />;
        }
        return <GroupList contentType="series" />;
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
                width: loadingPhase === 'fetching-playlist' ? '10%'
                  : loadingPhase === 'parsing-playlist' ? '30%'
                  : loadingPhase === 'fetching-epg' ? '50%'
                  : loadingPhase === 'parsing-epg' ? '70%'
                  : loadingPhase === 'done' ? '100%'
                  : '0%',
              }}
            />
          </div>
          <span className="app__loading-text">{loadingMessage}</span>
          <button className="app__loading-cancel" onClick={() => {
            cancelSync();
            requestAnimationFrame(() => {
              const sidebar = document.querySelector('.sidebar-item--active, .sidebar-item') as HTMLElement | null;
              sidebar?.focus();
            });
          }}>Cancel</button>
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

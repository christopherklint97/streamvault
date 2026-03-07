import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { useChannelStore } from './stores/channelStore';
import { useFavoritesStore } from './stores/favoritesStore';
import { useRemoteKeys } from './hooks/useRemoteKeys';
import { useNetworkStatus } from './hooks/useNetworkStatus';
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

  // Auto-load channels on mount if URL exists
  useEffect(() => {
    if (playlistUrl && channels.length === 0) {
      loadPlaylist(playlistUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <main className={`app__content${currentView === 'player' ? ' app__content--fullscreen' : ''}`}>
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

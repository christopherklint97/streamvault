import { useEffect, useCallback, useRef, useState } from 'react';
import { useAppStore } from './stores/appStore';
import { useChannelStore } from './stores/channelStore';
import { usePlayerStore } from './stores/playerStore';
import { useRemoteKeys } from './hooks/useRemoteKeys';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { KEY_CODES } from './utils/keys';
import { cn } from './utils/cn';
import { isMobile } from './utils/platform';
import { markTTI, startFPSMonitor, stopFPSMonitor } from './utils/perf-monitor';
import { parseUrl } from './utils/url-state';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import ExitDialog from './components/ExitDialog';
import Player from './components/Player';
import ChannelList from './components/ChannelList';
import SeriesDetail from './components/SeriesDetail';
import MovieDetail from './components/MovieDetail';
import Home from './pages/Home';
import EpgGuide from './components/EpgGuide';
import Recordings from './pages/Recordings';

import Settings from './pages/Settings';

/** Browse views that stay mounted once visited to preserve search/scroll state */
const BROWSE_VIEWS = [
  { view: 'channels' as const, contentType: 'livetv' as const },
  { view: 'movies' as const, contentType: 'movies' as const },
  { view: 'series' as const, contentType: 'series' as const },
] as const;

const MOBILE_APP = isMobile();

/** Persistent video element — adapts sizing for portrait live mode */
function AvPlayerVideo({ currentView }: { currentView: string }) {
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const groupChannels = usePlayerStore((s) => s.groupChannels);
  const channelListVisible = usePlayerStore((s) => s.channelListVisible);
  const isLive = currentChannel?.contentType === 'livetv';
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  const isPortraitLive = MOBILE_APP && isLive && !isFullscreen && channelListVisible && groupChannels.length > 0;

  return (
    <video
      id="av-player"
      playsInline
      className={cn(
        'fixed top-0 left-0 bg-black object-contain object-center',
        currentView === 'player'
          ? isPortraitLive
            ? 'w-full aspect-video z-[998]'
            : 'w-full h-dvh z-[998]'
          : 'w-px h-px -z-10 opacity-0 pointer-events-none'
      )}
    />
  );
}

function AppContent() {
  const currentView = useAppStore((s) => s.currentView);
  const selectedSeries = useAppStore((s) => s.selectedSeries);
  const selectedMovie = useAppStore((s) => s.selectedMovie);
  const visitedViews = useAppStore((s) => s.visitedViews);
  const isLoading = useChannelStore((s) => s.isLoading);
  const loadingMessage = useChannelStore((s) => s.loadingMessage);
  const loadingPhase = useChannelStore((s) => s.loadingPhase);
  const cancelSync = useChannelStore((s) => s.cancelSync);
  const hydrate = useChannelStore((s) => s.hydrate);
  const { isOnline } = useNetworkStatus();

  useRemoteKeys();

  // Browser back button support (mobile PWA)
  useEffect(() => {
    // Replace initial state so we have a baseline
    history.replaceState({ view: 'home', group: null }, '');

    const handlePopState = () => {
      useAppStore.getState().goBack();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Register Tizen remote keys, set initial focus, and start perf monitoring
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
      const firstItem = document.querySelector('[data-sidebar-item]') as HTMLElement | null;
      firstItem?.focus();
      // Mark Time To Interactive after first focus
      markTTI();
    });

    // Start FPS monitoring in dev mode
    if (import.meta.env.DEV) {
      startFPSMonitor();
      return () => stopFPSMonitor();
    }
  }, []);

  // Hydrate from server on startup
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Deep-link: ?play=channelId auto-starts playback (used by "Open in Safari" for PiP)
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const { playChannelId, playUrl } = parseUrl();
    if (!playChannelId) return;
    deepLinkHandled.current = true;

    // Clean the URL so refresh doesn't re-trigger
    const cleanUrl = window.location.pathname;
    history.replaceState(null, '', cleanUrl);

    // Fetch the channel and start playback
    const { fetchChannelsByIds } = useChannelStore.getState();
    fetchChannelsByIds([playChannelId]).then(channels => {
      if (channels.length > 0) {
        const channel = playUrl
          ? { ...channels[0], url: playUrl }
          : channels[0];
        usePlayerStore.getState().setChannel(channel);
        useAppStore.getState().navigate('player');
      }
    });
  }, []);

  // Handle LEFT key on main content to return focus to sidebar
  const handleMainKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.keyCode === KEY_CODES.LEFT) {
      e.preventDefault();
      const activeItem = document.querySelector('[data-sidebar-item][data-active]') as HTMLElement | null;
      const fallback = document.querySelector('[data-sidebar-item]') as HTMLElement | null;
      (activeItem ?? fallback)?.focus();
    }
  }, []);

  const isBrowseView = currentView === 'channels' || currentView === 'movies' || currentView === 'series';

  const renderView = () => {
    switch (currentView) {
      case 'home':
        return <Home />;
      case 'channels':
      case 'movies':
      case 'series':
        return null; // Rendered persistently below
      case 'seriesDetail':
        return selectedSeries ? <SeriesDetail series={selectedSeries} /> : null;
      case 'movieDetail':
        return selectedMovie ? <MovieDetail movie={selectedMovie} /> : null;
      case 'guide':
        return <EpgGuide />;
      case 'recordings':
        return <Recordings />;
      case 'player':
        return <Player />;
      case 'settings':
        return <Settings />;
      default:
        return <Home />;
    }
  };

  return (
    <div className="flex flex-col w-full h-dvh lg:flex-row lg:w-tv lg:h-tv overflow-hidden">
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[9999] p-2 lg:p-2.5 bg-[#c0392b] text-white text-center text-sm lg:text-18">
          No network connection. Some features may be unavailable.
        </div>
      )}
      {isLoading && currentView !== 'settings' && currentView !== 'player' && (
        <div className="fixed top-0 left-0 lg:left-[68px] right-0 z-[9998] flex items-center gap-4 px-4 py-2 lg:px-6 lg:py-3 bg-[rgba(12,12,22,0.95)] border-b border-surface-border animate-fade-in">
          <div className="flex-1 h-1 bg-surface-border rounded-sm overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-accent-green rounded-sm transition-[width] duration-400 ease-in-out"
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
          <span className="text-base lg:text-[16px] text-[#888]">{loadingMessage}</span>
          <button className="px-4 py-1.5 bg-[#222] rounded text-base lg:text-[16px] transition-colors duration-150 focus:bg-[#333] focus:text-white" onClick={() => {
            cancelSync();
            requestAnimationFrame(() => {
              const sidebar = document.querySelector('[data-sidebar-item][data-active], [data-sidebar-item]') as HTMLElement | null;
              sidebar?.focus();
            });
          }}>Cancel</button>
        </div>
      )}
      {currentView !== 'player' && <Sidebar />}
      <main
        data-app-content
        className={cn(
          'flex-1 overflow-y-auto p-4 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[72px] min-h-0 lg:p-8 lg:px-10 lg:pb-8',
          currentView === 'player' && '!p-0 !pb-0 w-full h-dvh lg:!w-tv lg:!h-tv'
        )}
        onKeyDown={currentView !== 'player' ? handleMainKeyDown : undefined}
      >
        {/* Persistent browse views — stay mounted once visited to preserve state */}
        {BROWSE_VIEWS.map(({ view, contentType }) => (
          (currentView === view || visitedViews[view]) ? (
            <div key={view} style={{ display: currentView === view ? undefined : 'none' }}>
              <ChannelList contentType={contentType} />
            </div>
          ) : null
        ))}
        {/* Non-persistent views render conditionally */}
        {!isBrowseView && renderView()}
      </main>
      {/* Persistent video element — stays in the DOM across view changes so
          playback continues in the background when navigating away from the player */}
      {!(typeof webapis !== 'undefined' && webapis.avplay) && (
        <AvPlayerVideo currentView={currentView} />
      )}
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

import { useState, useCallback } from 'react';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import type { InputMode, SyncInterval } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { useAppStore } from '../stores/appStore';
import { clearRecentChannels } from '../services/channel-service';
import FocusZone from '../components/FocusZone';
import { cn } from '../utils/cn';

function formatSyncTime(timestamp: number): string {
  if (!timestamp) return 'Never';
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

const SYNC_OPTIONS: { value: SyncInterval; label: string }[] = [
  { value: 'startup', label: 'Every startup' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: '24h', label: 'Every 24 hours' },
  { value: 'manual', label: 'Manual only' },
];

function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export default function Settings() {
  const inputMode = useChannelStore((s) => s.inputMode);
  const xtreamCredentials = useChannelStore((s) => s.xtreamCredentials);
  const playlistUrl = useChannelStore((s) => s.playlistUrl);
  const epgUrl = useChannelStore((s) => s.epgUrl);
  const channels = useChannelStore((s) => s.channels);
  const isLoading = useChannelStore((s) => s.isLoading);
  const error = useChannelStore((s) => s.error);
  const loadingPhase = useChannelStore((s) => s.loadingPhase);
  const loadingMessage = useChannelStore((s) => s.loadingMessage);
  const channelCount = useChannelStore((s) => s.channelCount);
  const syncInterval = useChannelStore((s) => s.syncInterval);
  const lastSyncTime = useChannelStore((s) => s.lastSyncTime);
  const isCrawling = useChannelStore((s) => s.isCrawling);
  const crawlProgress = useChannelStore((s) => s.crawlProgress);
  const lastCrawlTime = useChannelStore((s) => s.lastCrawlTime);
  const apiBaseUrl = useChannelStore((s) => s.apiBaseUrl);
  const setApiBaseUrl = useChannelStore((s) => s.setApiBaseUrl);
  const saveConfig = useChannelStore((s) => s.saveConfig);
  const triggerSync = useChannelStore((s) => s.triggerSync);
  const cancelSync = useChannelStore((s) => s.cancelSync);
  const triggerCrawl = useChannelStore((s) => s.triggerCrawl);
  const cancelCrawl = useChannelStore((s) => s.cancelCrawl);
  const hydrate = useChannelStore((s) => s.hydrate);
  const showToastMessage = useAppStore((s) => s.showToastMessage);

  const [localApiUrl, setLocalApiUrl] = useState(apiBaseUrl);
  const [localServerUrl, setLocalServerUrl] = useState(xtreamCredentials.serverUrl);
  const [localUsername, setLocalUsername] = useState(xtreamCredentials.username);
  const [localPassword, setLocalPassword] = useState(xtreamCredentials.password);
  const [localPlaylistUrl, setLocalPlaylistUrl] = useState(playlistUrl);
  const [localEpgUrl, setLocalEpgUrl] = useState(epgUrl);
  const [fieldError, setFieldError] = useState('');

  const handleConnectServer = useCallback(async () => {
    if (!localApiUrl.trim()) { setFieldError('Please enter a server URL'); return; }
    if (!isValidUrl(localApiUrl)) { setFieldError('Server URL must start with http:// or https://'); return; }
    setFieldError('');
    const url = localApiUrl.trim().replace(/\/+$/, '');
    setApiBaseUrl(url);
    // Test connection + load data
    try {
      const response = await fetch(`${url}/api/status`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      showToastMessage('Connected to server');
      // Trigger full hydration
      setTimeout(() => hydrate(), 100);
    } catch {
      setFieldError('Cannot connect to server');
    }
  }, [localApiUrl, setApiBaseUrl, showToastMessage, hydrate]);

  const handleModeSwitch = useCallback(async (mode: InputMode) => {
    setFieldError('');
    await saveConfig({ inputMode: mode });
  }, [saveConfig]);

  const handleSaveXtream = useCallback(async () => {
    if (!localServerUrl.trim()) { setFieldError('Please enter a server URL'); return; }
    if (!isValidUrl(localServerUrl)) { setFieldError('Server URL must start with http:// or https://'); return; }
    if (!localUsername.trim()) { setFieldError('Please enter a username'); return; }
    if (!localPassword.trim()) { setFieldError('Please enter a password'); return; }
    setFieldError('');
    await saveConfig({
      inputMode: 'xtream',
      xtreamServer: localServerUrl.trim(),
      xtreamUsername: localUsername.trim(),
      xtreamPassword: localPassword.trim(),
    });
    await triggerSync();
  }, [localServerUrl, localUsername, localPassword, saveConfig, triggerSync]);

  const handleSavePlaylist = useCallback(async () => {
    if (!localPlaylistUrl.trim()) { setFieldError('Please enter a playlist URL'); return; }
    if (!isValidUrl(localPlaylistUrl)) { setFieldError('URL must start with http:// or https://'); return; }
    setFieldError('');
    await saveConfig({
      inputMode: 'manual',
      playlistUrl: localPlaylistUrl.trim(),
      epgUrl: localEpgUrl.trim(),
    });
    await triggerSync();
  }, [localPlaylistUrl, localEpgUrl, saveConfig, triggerSync]);

  const handleSyncNow = useCallback(async () => {
    await triggerSync();
  }, [triggerSync]);

  const handleClearFavorites = useCallback(() => {
    const store = useFavoritesStore.getState();
    const ids = Array.from(store.favoriteIds);
    ids.forEach((id) => store.toggleFavorite(id));
    showToastMessage('Favorites cleared');
  }, [showToastMessage]);

  const handleClearRecent = useCallback(() => {
    clearRecentChannels();
    showToastMessage('Recently watched cleared');
  }, [showToastMessage]);

  const handleForceUpdate = useCallback(() => {
    showToastMessage('Reloading...');
    // Hard reload bypassing any browser cache
    setTimeout(() => window.location.replace(window.location.href), 300);
  }, [showToastMessage]);

  const handleSyncCycle = useCallback(async () => {
    const currentIndex = SYNC_OPTIONS.findIndex((o) => o.value === syncInterval);
    const nextIndex = (currentIndex + 1) % SYNC_OPTIONS.length;
    const next = SYNC_OPTIONS[nextIndex];
    await saveConfig({ syncInterval: next.value });
    showToastMessage(`Sync: ${next.label}`);
  }, [syncInterval, saveConfig, showToastMessage]);

  const syncLabel = SYNC_OPTIONS.find((o) => o.value === syncInterval)?.label ?? 'Every 24 hours';
  const isConnected = SAME_ORIGIN || !!apiBaseUrl;

  return (
    <FocusZone className="flex flex-col gap-5 lg:gap-7 max-w-full lg:max-w-[900px] outline-hidden animate-fade-in pb-6 lg:pb-0">
      <h1 className="text-28 font-bold">Settings</h1>

      {error && <div className="text-[#ff4757]">{error}</div>}

      {/* Loading Progress */}
      {isLoading && (
        <div className="flex flex-col gap-2">
          <div className="h-1 bg-surface-border rounded-sm overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-accent-green rounded-sm"
              style={{
                width: loadingPhase === 'fetching-playlist' ? '10%'
                  : loadingPhase === 'parsing-playlist' ? '30%'
                  : loadingPhase === 'fetching-epg' ? '50%'
                  : loadingPhase === 'parsing-epg' ? '70%'
                  : loadingPhase === 'done' ? '100%' : '0%',
              }}
            />
          </div>
          <span className="text-sm lg:text-base text-[#888]">{loadingMessage}</span>
          {channelCount > 0 && loadingPhase !== 'fetching-playlist' && (
            <span className="text-sm text-[#888]">{channelCount.toLocaleString()} channels found</span>
          )}
          <button
            className="py-2.5 px-5 lg:py-3 lg:px-7 bg-[#ff4757] text-white border-2 border-[#ff4757] rounded-lg text-sm lg:text-17 font-semibold self-start transition-all duration-150 tap-none focus:border-white focus:text-white focus:scale-[1.02] disabled:opacity-40"
            data-focusable
            tabIndex={0}
            onClick={() => {
              cancelSync();
              requestAnimationFrame(() => {
                const target = document.querySelector('[data-focusable]') as HTMLElement | null;
                target?.focus();
              });
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {!isLoading && loadingPhase === 'done' && loadingMessage && (
        <div className="text-success">{loadingMessage}</div>
      )}

      {/* Server Connection — hidden when PWA is served from same origin */}
      {!SAME_ORIGIN && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base lg:text-20 font-bold text-accent">Server</h2>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm lg:text-base text-[#666] font-semibold">StreamVault Server URL</label>
            <input
              className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
              type="text"
              data-focusable
              tabIndex={0}
              value={localApiUrl}
              onChange={(e) => setLocalApiUrl(e.target.value)}
              placeholder="http://192.168.0.100:3001"
            />
          </div>
          {fieldError && !isConnected && <span className="text-[#ff4757] text-sm">{fieldError}</span>}
          <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleConnectServer}>
            {isConnected ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      )}

      {isConnected && (
        <>
          {/* Input Mode Toggle */}
          <div className="flex flex-col gap-3">
            <h2 className="text-base lg:text-20 font-bold text-accent">Playlist Source</h2>
            <div className="flex gap-2">
              <button
                className={cn(
                  'py-2 px-4 lg:py-2.5 lg:px-6 border-2 rounded-lg text-sm lg:text-17 transition-all duration-150 tap-none focus:border-accent',
                  inputMode === 'xtream' ? 'bg-accent text-black border-accent' : 'bg-surface border-surface-border text-[#888]'
                )}
                data-focusable
                tabIndex={0}
                onClick={() => handleModeSwitch('xtream')}
              >
                Xtream Codes
              </button>
              <button
                className={cn(
                  'py-2 px-4 lg:py-2.5 lg:px-6 border-2 rounded-lg text-sm lg:text-17 transition-all duration-150 tap-none focus:border-accent',
                  inputMode === 'manual' ? 'bg-accent text-black border-accent' : 'bg-surface border-surface-border text-[#888]'
                )}
                data-focusable
                tabIndex={0}
                onClick={() => handleModeSwitch('manual')}
              >
                Direct URL
              </button>
            </div>
          </div>

          {/* Xtream Codes Input */}
          {inputMode === 'xtream' && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base lg:text-20 font-bold text-accent">Xtream Codes Login</h2>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm lg:text-base text-[#666] font-semibold">Server URL</label>
                <input
                  className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
                  type="text"
                  data-focusable
                  tabIndex={0}
                  value={localServerUrl}
                  onChange={(e) => setLocalServerUrl(e.target.value)}
                  placeholder="http://example.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm lg:text-base text-[#666] font-semibold">Username</label>
                <input
                  className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
                  type="text"
                  data-focusable
                  tabIndex={0}
                  value={localUsername}
                  onChange={(e) => setLocalUsername(e.target.value)}
                  placeholder="Your username"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm lg:text-base text-[#666] font-semibold">Password</label>
                <input
                  className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
                  type="text"
                  data-focusable
                  tabIndex={0}
                  value={localPassword}
                  onChange={(e) => setLocalPassword(e.target.value)}
                  placeholder="Your password"
                />
              </div>
              {fieldError && isConnected && <span className="text-[#ff4757] text-sm">{fieldError}</span>}
              <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleSaveXtream} disabled={isLoading}>
                {isLoading ? 'Syncing...' : 'Connect & Sync'}
              </button>
            </div>
          )}

          {/* Manual URL Input */}
          {inputMode === 'manual' && (
            <>
              <div className="flex flex-col gap-3">
                <h2 className="text-base lg:text-20 font-bold text-accent">Playlist</h2>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm lg:text-base text-[#666] font-semibold">Playlist URL (M3U/M3U8)</label>
                  <input
                    className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
                    type="text"
                    data-focusable
                    tabIndex={0}
                    value={localPlaylistUrl}
                    onChange={(e) => setLocalPlaylistUrl(e.target.value)}
                    placeholder="https://example.com/playlist.m3u"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm lg:text-base text-[#666] font-semibold">EPG URL (XMLTV, optional)</label>
                  <input
                    className="py-2.5 px-3.5 lg:py-3 lg:px-4 text-base lg:text-20 bg-surface border-2 border-surface-border rounded-lg text-[#e8eaed] transition-colors duration-200 focus:border-accent"
                    type="text"
                    data-focusable
                    tabIndex={0}
                    value={localEpgUrl}
                    onChange={(e) => setLocalEpgUrl(e.target.value)}
                    placeholder="https://example.com/epg.xml"
                  />
                </div>
                {fieldError && isConnected && <span className="text-[#ff4757] text-sm">{fieldError}</span>}
                <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleSavePlaylist} disabled={isLoading}>
                  {isLoading ? 'Syncing...' : 'Save & Sync'}
                </button>
              </div>
            </>
          )}

          {/* Sync Settings */}
          <div className="flex flex-col gap-3">
            <h2 className="text-base lg:text-20 font-bold text-accent">Sync</h2>
            <div className="flex items-center gap-2 text-sm lg:text-base text-[#888]">
              <span className="text-[#888]">Last synced:</span>
              <span className="text-[#ccc]">{formatSyncTime(lastSyncTime)}</span>
            </div>
            <div className="flex items-center gap-2 text-sm lg:text-base text-[#888]">
              <span className="text-[#888]">Auto-sync:</span>
              <button className="py-1.5 px-3.5 lg:py-2 lg:px-5 bg-surface border-2 border-surface-border rounded-lg text-sm lg:text-base text-[#aaa] transition-colors duration-150 focus:border-accent" data-focusable tabIndex={0} onClick={handleSyncCycle}>
                {syncLabel}
              </button>
            </div>
            <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleSyncNow} disabled={isLoading}>
              {isLoading ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>

          {/* Stream Library */}
          <div className="flex flex-col gap-3">
            <h2 className="text-base lg:text-20 font-bold text-accent">Stream Library</h2>
            <div className="flex items-center gap-2 text-sm lg:text-base text-[#888]">
              <span className="text-[#888]">Streams cached:</span>
              <span className="text-[#ccc]">{channels.length.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2 text-sm lg:text-base text-[#888]">
              <span className="text-[#888]">Last full crawl:</span>
              <span className="text-[#ccc]">{formatSyncTime(lastCrawlTime)}</span>
            </div>
            {isCrawling && crawlProgress && (
              <div className="flex items-center gap-2 text-sm lg:text-base text-[#888]">
                <span className="text-[#888]">Progress:</span>
                <span className="text-[#ccc]">{crawlProgress}</span>
              </div>
            )}
            <p className="text-13 text-[#555] my-2 lg:mb-3 leading-snug">
              Full crawl downloads all streams for instant search. Runs automatically at 3 AM daily.
            </p>
            {isCrawling ? (
              <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-[#ff4757] text-white border-2 border-[#ff4757] rounded-lg text-sm lg:text-17 font-semibold self-start transition-all duration-150 tap-none focus:border-white focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={cancelCrawl}>
                Cancel Crawl
              </button>
            ) : (
              <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={triggerCrawl}>
                Crawl All Streams Now
              </button>
            )}
          </div>

          {/* Data Management */}
          <div className="flex flex-col gap-3">
            <h2 className="text-base lg:text-20 font-bold text-accent">Data Management</h2>
            <div className="flex flex-wrap gap-2 lg:gap-3">
              <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-[#ff4757] text-white border-2 border-[#ff4757] rounded-lg text-sm lg:text-17 font-semibold self-start transition-all duration-150 tap-none focus:border-white focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleClearFavorites}>
                Clear Favorites
              </button>
              <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-[#ff4757] text-white border-2 border-[#ff4757] rounded-lg text-sm lg:text-17 font-semibold self-start transition-all duration-150 tap-none focus:border-white focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleClearRecent}>
                Clear Recently Watched
              </button>
            </div>
          </div>

          {/* App Update */}
          <div className="flex flex-col gap-3">
            <h2 className="text-base lg:text-20 font-bold text-accent">App</h2>
            <button className="py-2.5 px-5 lg:py-3 lg:px-7 bg-surface-hover border-2 border-[#222] rounded-lg text-sm lg:text-17 font-semibold text-[#ccc] self-start transition-all duration-150 tap-none focus:border-accent focus:text-white focus:scale-[1.02] disabled:opacity-40" data-focusable tabIndex={0} onClick={handleForceUpdate}>
              Check for Update
            </button>
          </div>
        </>
      )}
    </FocusZone>
  );
}

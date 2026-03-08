import { useState, useCallback } from 'react';
import { useChannelStore } from '../stores/channelStore';
import type { InputMode, SyncInterval } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { useAppStore } from '../stores/appStore';
import { clearRecentChannels } from '../services/channel-service';
import FocusZone from '../components/FocusZone';

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
  const setInputMode = useChannelStore((s) => s.setInputMode);
  const setXtreamCredentials = useChannelStore((s) => s.setXtreamCredentials);
  const setPlaylistUrl = useChannelStore((s) => s.setPlaylistUrl);
  const setEpgUrl = useChannelStore((s) => s.setEpgUrl);
  const loadPlaylist = useChannelStore((s) => s.loadPlaylist);
  const loadEPG = useChannelStore((s) => s.loadEPG);
  const loadFromXtream = useChannelStore((s) => s.loadFromXtream);
  const setSyncInterval = useChannelStore((s) => s.setSyncInterval);
  const syncNow = useChannelStore((s) => s.syncNow);
  const showToastMessage = useAppStore((s) => s.showToastMessage);

  const [localServerUrl, setLocalServerUrl] = useState(xtreamCredentials.serverUrl);
  const [localUsername, setLocalUsername] = useState(xtreamCredentials.username);
  const [localPassword, setLocalPassword] = useState(xtreamCredentials.password);
  const [localPlaylistUrl, setLocalPlaylistUrl] = useState(playlistUrl);
  const [localEpgUrl, setLocalEpgUrl] = useState(epgUrl);
  const [fieldError, setFieldError] = useState('');

  const handleModeSwitch = useCallback((mode: InputMode) => {
    setInputMode(mode);
    setFieldError('');
  }, [setInputMode]);

  const handleLoadXtream = useCallback(async () => {
    if (!localServerUrl.trim()) { setFieldError('Please enter a server URL'); return; }
    if (!isValidUrl(localServerUrl)) { setFieldError('Server URL must start with http:// or https://'); return; }
    if (!localUsername.trim()) { setFieldError('Please enter a username'); return; }
    if (!localPassword.trim()) { setFieldError('Please enter a password'); return; }
    setFieldError('');
    setXtreamCredentials({ serverUrl: localServerUrl.trim(), username: localUsername.trim(), password: localPassword.trim() });
    await loadFromXtream();
    const state = useChannelStore.getState();
    if (!state.error) showToastMessage(`Loaded ${state.channels.length} channels`);
  }, [localServerUrl, localUsername, localPassword, setXtreamCredentials, loadFromXtream, showToastMessage]);

  const handleLoadPlaylist = useCallback(async () => {
    if (!localPlaylistUrl.trim()) { setFieldError('Please enter a playlist URL'); return; }
    if (!isValidUrl(localPlaylistUrl)) { setFieldError('URL must start with http:// or https://'); return; }
    setFieldError('');
    setPlaylistUrl(localPlaylistUrl);
    await loadPlaylist(localPlaylistUrl);
    const state = useChannelStore.getState();
    if (!state.error) showToastMessage(`Loaded ${state.channels.length} channels`);
  }, [localPlaylistUrl, setPlaylistUrl, loadPlaylist, showToastMessage]);

  const handleLoadEPG = useCallback(async () => {
    if (!localEpgUrl.trim()) { setFieldError('Please enter an EPG URL'); return; }
    if (!isValidUrl(localEpgUrl)) { setFieldError('URL must start with http:// or https://'); return; }
    setFieldError('');
    setEpgUrl(localEpgUrl);
    await loadEPG(localEpgUrl);
    const state = useChannelStore.getState();
    if (!state.error) showToastMessage('EPG data loaded successfully');
  }, [localEpgUrl, setEpgUrl, loadEPG, showToastMessage]);

  const handleSyncNow = useCallback(async () => {
    await syncNow();
    const state = useChannelStore.getState();
    if (!state.error) showToastMessage('Sync complete');
  }, [syncNow, showToastMessage]);

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

  const handleSyncCycle = useCallback(() => {
    const currentIndex = SYNC_OPTIONS.findIndex((o) => o.value === syncInterval);
    const nextIndex = (currentIndex + 1) % SYNC_OPTIONS.length;
    setSyncInterval(SYNC_OPTIONS[nextIndex].value);
    showToastMessage(`Sync: ${SYNC_OPTIONS[nextIndex].label}`);
  }, [syncInterval, setSyncInterval, showToastMessage]);

  const syncLabel = SYNC_OPTIONS.find((o) => o.value === syncInterval)?.label ?? 'Every 24 hours';

  return (
    <FocusZone className="settings">
      <h1 className="settings__title">Settings</h1>

      {error && <div className="settings__error">{error}</div>}

      {/* Loading Progress */}
      {isLoading && (
        <div className="settings__progress">
          <div className="settings__progress-bar">
            <div
              className="settings__progress-fill"
              style={{
                width: loadingPhase === 'fetching-playlist' ? '15%'
                  : loadingPhase === 'parsing-playlist' ? '40%'
                  : loadingPhase === 'fetching-epg' ? '60%'
                  : loadingPhase === 'parsing-epg' ? '85%'
                  : loadingPhase === 'done' ? '100%' : '0%',
              }}
            />
          </div>
          <span className="settings__progress-text">{loadingMessage}</span>
          {channelCount > 0 && loadingPhase !== 'fetching-playlist' && (
            <span className="settings__progress-count">{channelCount} channels found</span>
          )}
        </div>
      )}

      {!isLoading && loadingPhase === 'done' && loadingMessage && (
        <div className="settings__success">{loadingMessage}</div>
      )}

      {/* Input Mode Toggle */}
      <div className="settings__section">
        <h2 className="settings__section-title">Playlist Source</h2>
        <div className="settings__mode-toggle">
          <button
            className={`settings__mode-btn${inputMode === 'xtream' ? ' settings__mode-btn--active' : ''}`}
            data-focusable
            tabIndex={0}
            onClick={() => handleModeSwitch('xtream')}
          >
            Xtream Codes
          </button>
          <button
            className={`settings__mode-btn${inputMode === 'manual' ? ' settings__mode-btn--active' : ''}`}
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
        <div className="settings__section">
          <h2 className="settings__section-title">Xtream Codes Login</h2>
          <div className="settings__field">
            <label className="settings__label">Server URL</label>
            <input
              className="settings__input"
              type="text"
              data-focusable
              tabIndex={0}
              value={localServerUrl}
              onChange={(e) => setLocalServerUrl(e.target.value)}
              placeholder="http://example.com"
            />
          </div>
          <div className="settings__field">
            <label className="settings__label">Username</label>
            <input
              className="settings__input"
              type="text"
              data-focusable
              tabIndex={0}
              value={localUsername}
              onChange={(e) => setLocalUsername(e.target.value)}
              placeholder="Your username"
            />
          </div>
          <div className="settings__field">
            <label className="settings__label">Password</label>
            <input
              className="settings__input"
              type="text"
              data-focusable
              tabIndex={0}
              value={localPassword}
              onChange={(e) => setLocalPassword(e.target.value)}
              placeholder="Your password"
            />
          </div>
          {fieldError && <span className="settings__field-error">{fieldError}</span>}
          <button className="settings__btn" data-focusable tabIndex={0} onClick={handleLoadXtream} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Connect & Load'}
          </button>
        </div>
      )}

      {/* Manual URL Input */}
      {inputMode === 'manual' && (
        <>
          <div className="settings__section">
            <h2 className="settings__section-title">Playlist</h2>
            <div className="settings__field">
              <label className="settings__label">Playlist URL (M3U/M3U8)</label>
              <input
                className="settings__input"
                type="text"
                data-focusable
                tabIndex={0}
                value={localPlaylistUrl}
                onChange={(e) => setLocalPlaylistUrl(e.target.value)}
                placeholder="https://example.com/playlist.m3u"
              />
            </div>
            {fieldError && <span className="settings__field-error">{fieldError}</span>}
            <button className="settings__btn" data-focusable tabIndex={0} onClick={handleLoadPlaylist} disabled={isLoading}>
              {isLoading ? 'Loading...' : 'Load Channels'}
            </button>
          </div>
          <div className="settings__section">
            <h2 className="settings__section-title">EPG (Electronic Program Guide)</h2>
            <div className="settings__field">
              <label className="settings__label">EPG URL (XMLTV)</label>
              <input
                className="settings__input"
                type="text"
                data-focusable
                tabIndex={0}
                value={localEpgUrl}
                onChange={(e) => setLocalEpgUrl(e.target.value)}
                placeholder="https://example.com/epg.xml"
              />
            </div>
            <button className="settings__btn" data-focusable tabIndex={0} onClick={handleLoadEPG} disabled={isLoading}>
              {isLoading ? 'Loading...' : 'Load EPG'}
            </button>
          </div>
        </>
      )}

      {/* Sync Settings */}
      <div className="settings__section">
        <h2 className="settings__section-title">Sync</h2>
        <div className="settings__info-row">
          <span className="settings__info-label">Last synced:</span>
          <span className="settings__info-value">{formatSyncTime(lastSyncTime)}</span>
        </div>
        <div className="settings__info-row">
          <span className="settings__info-label">Auto-sync:</span>
          <button className="settings__sync-toggle" data-focusable tabIndex={0} onClick={handleSyncCycle}>
            {syncLabel}
          </button>
        </div>
        <button className="settings__btn" data-focusable tabIndex={0} onClick={handleSyncNow} disabled={isLoading || !playlistUrl}>
          {isLoading ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      {/* Info */}
      <div className="settings__section">
        <h2 className="settings__section-title">Info</h2>
        <div className="settings__info-row">
          <span className="settings__info-label">Channels loaded:</span>
          <span className="settings__info-value">{channels.length}</span>
        </div>
      </div>

      {/* Data Management */}
      <div className="settings__section">
        <h2 className="settings__section-title">Data Management</h2>
        <div className="settings__btn-row">
          <button className="settings__btn settings__btn--danger" data-focusable tabIndex={0} onClick={handleClearFavorites}>
            Clear Favorites
          </button>
          <button className="settings__btn settings__btn--danger" data-focusable tabIndex={0} onClick={handleClearRecent}>
            Clear Recently Watched
          </button>
        </div>
      </div>
    </FocusZone>
  );
}

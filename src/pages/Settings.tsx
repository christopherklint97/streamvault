import { useState, useRef, useCallback } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { useAppStore } from '../stores/appStore';
import { clearRecentChannels } from '../services/channel-service';
import { useFocusNavigation } from '../hooks/useFocusNavigation';
import { KEY_CODES } from '../utils/keys';

function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export default function Settings() {
  const playlistUrl = useChannelStore((s) => s.playlistUrl);
  const epgUrl = useChannelStore((s) => s.epgUrl);
  const channels = useChannelStore((s) => s.channels);
  const isLoading = useChannelStore((s) => s.isLoading);
  const error = useChannelStore((s) => s.error);
  const setPlaylistUrl = useChannelStore((s) => s.setPlaylistUrl);
  const setEpgUrl = useChannelStore((s) => s.setEpgUrl);
  const loadPlaylist = useChannelStore((s) => s.loadPlaylist);
  const loadEPG = useChannelStore((s) => s.loadEPG);
  const showToastMessage = useAppStore((s) => s.showToastMessage);

  const [localPlaylistUrl, setLocalPlaylistUrl] = useState(playlistUrl);
  const [localEpgUrl, setLocalEpgUrl] = useState(epgUrl);
  const [playlistError, setPlaylistError] = useState('');
  const [epgError, setEpgError] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  useFocusNavigation(containerRef, 1);

  const handleLoadPlaylist = useCallback(async () => {
    if (!localPlaylistUrl.trim()) {
      setPlaylistError('Please enter a playlist URL');
      return;
    }
    if (!isValidUrl(localPlaylistUrl)) {
      setPlaylistError('URL must start with http:// or https://');
      return;
    }
    setPlaylistError('');
    setPlaylistUrl(localPlaylistUrl);
    await loadPlaylist(localPlaylistUrl);
    const currentError = useChannelStore.getState().error;
    if (!currentError) {
      const count = useChannelStore.getState().channels.length;
      showToastMessage(`Loaded ${count} channels`);
    }
  }, [localPlaylistUrl, setPlaylistUrl, loadPlaylist, showToastMessage]);

  const handleLoadEPG = useCallback(async () => {
    if (!localEpgUrl.trim()) {
      setEpgError('Please enter an EPG URL');
      return;
    }
    if (!isValidUrl(localEpgUrl)) {
      setEpgError('URL must start with http:// or https://');
      return;
    }
    setEpgError('');
    setEpgUrl(localEpgUrl);
    await loadEPG(localEpgUrl);
    const currentError = useChannelStore.getState().error;
    if (!currentError) {
      showToastMessage('EPG data loaded successfully');
    }
  }, [localEpgUrl, setEpgUrl, loadEPG, showToastMessage]);

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

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    // Allow normal typing in input fields - only intercept navigation keys
    if (
      e.keyCode === KEY_CODES.UP ||
      e.keyCode === KEY_CODES.DOWN
    ) {
      // Let focus navigation handle it
      return;
    }
    // Stop propagation for all other keys so typing works
    if (e.keyCode !== KEY_CODES.ENTER && e.keyCode !== KEY_CODES.BACK) {
      e.stopPropagation();
    }
  };

  return (
    <div className="settings" ref={containerRef} tabIndex={0}>
      <h1 className="settings__title">Settings</h1>

      {error && <div className="settings__error">{error}</div>}

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
            onKeyDown={handleInputKeyDown}
            placeholder="https://example.com/playlist.m3u"
          />
          {playlistError && <span className="settings__field-error">{playlistError}</span>}
        </div>
        <button
          className="settings__btn"
          data-focusable
          tabIndex={0}
          onClick={handleLoadPlaylist}
          onKeyDown={(e) => {
            if (e.keyCode === KEY_CODES.ENTER) {
              e.preventDefault();
              handleLoadPlaylist();
            }
          }}
          disabled={isLoading}
        >
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
            onKeyDown={handleInputKeyDown}
            placeholder="https://example.com/epg.xml"
          />
          {epgError && <span className="settings__field-error">{epgError}</span>}
        </div>
        <button
          className="settings__btn"
          data-focusable
          tabIndex={0}
          onClick={handleLoadEPG}
          onKeyDown={(e) => {
            if (e.keyCode === KEY_CODES.ENTER) {
              e.preventDefault();
              handleLoadEPG();
            }
          }}
          disabled={isLoading}
        >
          {isLoading ? 'Loading...' : 'Load EPG'}
        </button>
      </div>

      <div className="settings__section">
        <h2 className="settings__section-title">Info</h2>
        <div className="settings__info-row">
          <span className="settings__info-label">Channels loaded:</span>
          <span className="settings__info-value">{channels.length}</span>
        </div>
      </div>

      <div className="settings__section">
        <h2 className="settings__section-title">Data Management</h2>
        <div className="settings__btn-row">
          <button
            className="settings__btn settings__btn--danger"
            data-focusable
            tabIndex={0}
            onClick={handleClearFavorites}
            onKeyDown={(e) => {
              if (e.keyCode === KEY_CODES.ENTER) {
                e.preventDefault();
                handleClearFavorites();
              }
            }}
          >
            Clear Favorites
          </button>
          <button
            className="settings__btn settings__btn--danger"
            data-focusable
            tabIndex={0}
            onClick={handleClearRecent}
            onKeyDown={(e) => {
              if (e.keyCode === KEY_CODES.ENTER) {
                e.preventDefault();
                handleClearRecent();
              }
            }}
          >
            Clear Recently Watched
          </button>
        </div>
      </div>
    </div>
  );
}

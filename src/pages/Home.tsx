import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { Channel, View } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { isMobile } from '../utils/platform';

const MOBILE = isMobile();
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import {
  getRecentChannelIds,
  getLastWatchedChannelId,
  getContinueWatchingIds,
  getWatchProgress,
} from '../services/channel-service';
import { getCurrentProgram } from '../services/epg-service';
import { KEY_CODES } from '../utils/keys';
import HorizontalRow from '../components/HorizontalRow';

export default function Home() {
  const channels = useChannelStore((s) => s.channels);
  const programs = useChannelStore((s) => s.programs);
  const contentTypeCounts = useChannelStore((s) => s.contentTypeCounts);
  const favoriteIds = useFavoritesStore((s) => s.favoriteIds);
  const lists = useFavoritesStore((s) => s.lists);
  const createList = useFavoritesStore((s) => s.createList);
  const deleteList = useFavoritesStore((s) => s.deleteList);
  const renameList = useFavoritesStore((s) => s.renameList);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);

  const [newListName, setNewListName] = useState('');
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editingListName, setEditingListName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const favoriteChannels = useMemo(
    () => channels.filter((ch) => favoriteIds.has(ch.id)),
    [channels, favoriteIds]
  );

  const recentChannels = useMemo(() => {
    const recentIds = getRecentChannelIds();
    const channelMap = new Map(channels.map((ch) => [ch.id, ch]));
    return recentIds.map((id) => channelMap.get(id)).filter(Boolean) as Channel[];
  }, [channels]);

  const lastWatchedChannel = useMemo(() => {
    const lastId = getLastWatchedChannelId();
    if (!lastId) return null;
    return channels.find((ch) => ch.id === lastId) || null;
  }, [channels]);

  const continueWatchingChannels = useMemo(() => {
    const cwIds = getContinueWatchingIds();
    const channelMap = new Map(channels.map((ch) => [ch.id, ch]));
    return cwIds.map((id) => channelMap.get(id)).filter(Boolean) as Channel[];
  }, [channels]);

  const navigateToSeries = useAppStore((s) => s.navigateToSeries);
  const navigateToMovie = useAppStore((s) => s.navigateToMovie);

  const handleSelectChannel = useCallback(
    (channel: Channel) => {
      // Series containers have no URL — open series detail instead
      if (channel.contentType === 'series' && !channel.url) {
        navigateToSeries(channel);
        return;
      }
      // Movies go to detail page
      if (channel.contentType === 'movies') {
        navigateToMovie(channel);
        return;
      }
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate, navigateToSeries, navigateToMovie]
  );

  const lastWatchedProgram = lastWatchedChannel
    ? getCurrentProgram(programs, lastWatchedChannel.id)
    : null;

  const typeCounts = useMemo(() => ({
    livetv: contentTypeCounts['livetv'] || 0,
    movies: contentTypeCounts['movies'] || 0,
    series: contentTypeCounts['series'] || 0,
  }), [contentTypeCounts]);

  // Simple key handler: ENTER clicks, UP/DOWN/LEFT/RIGHT navigate focusables
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const active = document.activeElement as HTMLElement;
    if (!active) return;

    // Text inputs: pass through LEFT/RIGHT
    if (active.tagName === 'INPUT' && (e.keyCode === KEY_CODES.LEFT || e.keyCode === KEY_CODES.RIGHT)) return;

    if (e.keyCode === KEY_CODES.ENTER) {
      if (active.tagName !== 'INPUT') {
        e.preventDefault();
        active.click();
      }
      return;
    }

    // Simple sequential navigation through all focusables
    const container = containerRef.current;
    if (!container) return;
    const items = container.querySelectorAll('[data-focusable]') as NodeListOf<HTMLElement>;
    if (items.length === 0) return;

    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i] === active) { idx = i; break; }
    }

    let next = idx;
    if (e.keyCode === KEY_CODES.DOWN) {
      next = Math.min(idx + 1, items.length - 1);
    } else if (e.keyCode === KEY_CODES.UP) {
      next = Math.max(idx - 1, 0);
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      next = Math.min(idx + 1, items.length - 1);
    } else if (e.keyCode === KEY_CODES.LEFT) {
      if (idx <= 0) return; // bubble to sidebar
      next = idx - 1;
    } else {
      return;
    }

    if (next !== idx && next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[next].focus({ preventScroll: true });
      items[next].scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Auto-focus first item on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const first = container.querySelector('[data-focusable]') as HTMLElement | null;
      first?.focus({ preventScroll: true });
    });
  }, []);

  const hasContent = typeCounts.livetv > 0 || typeCounts.movies > 0 || typeCounts.series > 0 || channels.length > 0;
  if (!hasContent) {
    return (
      <div className="home home--empty" ref={containerRef} onKeyDown={handleKeyDown}>
        <div className="home__welcome">
          <h1>Welcome to StreamVault</h1>
          <p>Go to Settings to add a playlist URL and start watching.</p>
          <button
            className="home__welcome-btn"
            data-focusable
            tabIndex={0}
            onClick={() => navigate('settings')}
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="home" ref={containerRef} onKeyDown={handleKeyDown}>
      {/* Continue Watching */}
      {continueWatchingChannels.length > 0 && (
        <div className="home__section">
          <h2 className="home__section-title">Continue Watching</h2>
          <div className="home__continue-watching">
            {continueWatchingChannels.map((ch) => {
              const progress = getWatchProgress(ch.id);
              const pct = progress && progress.duration > 0
                ? Math.round((progress.position / progress.duration) * 100)
                : 0;
              return (
                <div
                  key={ch.id}
                  className="home__cw-card"
                  data-focusable
                  tabIndex={-1}
                  onClick={() => handleSelectChannel(ch)}
                >
                  <div className="home__cw-logo">
                    {ch.logo ? (
                      <img src={ch.logo} alt={ch.name} width={64} height={48} loading="lazy" decoding="async" />
                    ) : (
                      <div className="home__cw-letter">
                        {ch.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="home__cw-info">
                    <span className="home__cw-name">{ch.name}</span>
                    <span className="home__cw-group">{ch.group}</span>
                  </div>
                  <div className="home__cw-progress-bar">
                    <div className="home__cw-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Last Watched */}
      {lastWatchedChannel && (
        <div className="home__section">
          <h2 className="home__section-title">Pick Up Where You Left Off</h2>
          <div
            className="home__hero-card"
            data-focusable
            tabIndex={-1}
            onClick={() => handleSelectChannel(lastWatchedChannel)}
          >
            <div className="home__hero-logo">
              {lastWatchedChannel.logo ? (
                <img src={lastWatchedChannel.logo} alt={lastWatchedChannel.name} width={56} height={48} loading="lazy" decoding="async" />
              ) : (
                <div className="home__hero-letter">
                  {lastWatchedChannel.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="home__hero-info">
              <h3>{lastWatchedChannel.name}</h3>
              {lastWatchedProgram && <p>{lastWatchedProgram.title}</p>}
              <span className="home__hero-group">{lastWatchedChannel.group}</span>
            </div>
          </div>
        </div>
      )}

      {/* Favorites */}
      {favoriteChannels.length > 0 && (
        <div className="home__section">
          <HorizontalRow
            title="Favorites"
            channels={favoriteChannels}
            onSelect={handleSelectChannel}
          />
        </div>
      )}

      {/* Custom Lists */}
      {lists.map(list => {
        const listChannels = channels.filter(ch => list.channelIds.includes(ch.id));
        if (listChannels.length === 0) return null;
        return (
          <div key={list.id} className="home__section">
            <div className="home__list-header">
              {editingListId === list.id ? (
                <form className="home__list-rename" onSubmit={(e) => {
                  e.preventDefault();
                  if (editingListName.trim()) {
                    renameList(list.id, editingListName.trim());
                  }
                  setEditingListId(null);
                }}>
                  <input
                    className="home__list-rename-input"
                    value={editingListName}
                    onChange={(e) => setEditingListName(e.target.value)}
                    autoFocus
                    onBlur={() => setEditingListId(null)}
                  />
                </form>
              ) : (
                <h2
                  className="home__section-title"
                  onClick={MOBILE ? () => { setEditingListId(list.id); setEditingListName(list.name); } : undefined}
                >
                  {list.name}
                </h2>
              )}
              {MOBILE && (
                <button
                  className="home__list-delete"
                  onClick={() => deleteList(list.id)}
                >
                  {'\u2715'}
                </button>
              )}
            </div>
            <HorizontalRow
              title=""
              channels={listChannels}
              onSelect={handleSelectChannel}
            />
          </div>
        );
      })}

      {/* Create New List */}
      {MOBILE && (
        <div className="home__section">
          <form className="home__new-list" onSubmit={(e) => {
            e.preventDefault();
            if (newListName.trim()) {
              createList(newListName.trim());
              setNewListName('');
            }
          }}>
            <input
              className="home__new-list-input"
              type="text"
              placeholder="Create new list..."
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
            />
            {newListName.trim() && (
              <button className="home__new-list-btn" type="submit">Create</button>
            )}
          </form>
        </div>
      )}

      {/* Recently Watched */}
      {recentChannels.length > 0 && (
        <div className="home__section">
          <HorizontalRow
            title="Recently Watched"
            channels={recentChannels}
            onSelect={handleSelectChannel}
          />
        </div>
      )}

      {/* Browse by Type */}
      <div className="home__section">
        <h2 className="home__section-title">Browse</h2>
        <div className="home__categories">
          {([
            { label: 'Live TV', view: 'channels' as View, count: typeCounts.livetv },
            { label: 'Movies', view: 'movies' as View, count: typeCounts.movies },
            { label: 'Series', view: 'series' as View, count: typeCounts.series },
          ]).map((item) => (
            <button
              key={item.view}
              className="home__category-tile"
              data-focusable
              tabIndex={-1}
              onClick={() => navigate(item.view)}
            >
              {item.label} ({item.count})
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

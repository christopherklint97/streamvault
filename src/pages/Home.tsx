import { useMemo, useCallback } from 'react';
import type { Channel, View } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import {
  getRecentChannelIds,
  getLastWatchedChannelId,
  getContinueWatchingIds,
  getWatchProgress,
} from '../services/channel-service';
import { getCurrentProgram } from '../services/epg-service';
import HorizontalRow from '../components/HorizontalRow';
import FocusZone from '../components/FocusZone';

export default function Home() {
  const channels = useChannelStore((s) => s.channels);
  const programs = useChannelStore((s) => s.programs);
  const contentTypeCounts = useChannelStore((s) => s.contentTypeCounts);
  const favoriteIds = useFavoritesStore((s) => s.favoriteIds);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);

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

  const handleSelectChannel = useCallback(
    (channel: Channel) => {
      setChannel(channel);
      navigate('player');
    },
    [setChannel, navigate]
  );

  const lastWatchedProgram = lastWatchedChannel
    ? getCurrentProgram(programs, lastWatchedChannel.id)
    : null;

  const typeCounts = useMemo(() => ({
    livetv: contentTypeCounts['livetv'] || 0,
    movies: contentTypeCounts['movies'] || 0,
    series: contentTypeCounts['series'] || 0,
  }), [contentTypeCounts]);

  const handleContentTypeSelect = useCallback(
    (view: View) => {
      navigate(view);
    },
    [navigate]
  );

  const hasContent = typeCounts.livetv > 0 || typeCounts.movies > 0 || typeCounts.series > 0 || channels.length > 0;
  if (!hasContent) {
    return (
      <FocusZone className="home home--empty">
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
      </FocusZone>
    );
  }

  return (
    <FocusZone className="home">
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
                  tabIndex={0}
                  onClick={() => handleSelectChannel(ch)}
                >
                  <div className="home__cw-logo">
                    {ch.logo ? (
                      <img src={ch.logo} alt={ch.name} />
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
            tabIndex={0}
            onClick={() => handleSelectChannel(lastWatchedChannel)}
          >
            <div className="home__hero-logo">
              {lastWatchedChannel.logo ? (
                <img src={lastWatchedChannel.logo} alt={lastWatchedChannel.name} />
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
              tabIndex={0}
              onClick={() => handleContentTypeSelect(item.view)}
            >
              {item.label} ({item.count})
            </button>
          ))}
        </div>
      </div>
    </FocusZone>
  );
}

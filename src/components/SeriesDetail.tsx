import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Channel, SeriesInfo, Episode } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { getWatchProgress } from '../services/channel-service';
import { KEY_CODES } from '../utils/keys';
import { isMobile } from '../utils/platform';

const MOBILE = isMobile();

interface SeriesDetailProps {
  series: Channel;
}

export default function SeriesDetail({ series }: SeriesDetailProps) {
  const [info, setInfo] = useState<SeriesInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [focusIndex, setFocusIndex] = useState(0);
  const fetchSeriesInfo = useChannelStore((s) => s.fetchSeriesInfo);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const goBack = useAppStore((s) => s.goBack);
  const episodeListRef = useRef<HTMLDivElement>(null);

  // Extract numeric series ID from prefixed ID (e.g., "series_12345" -> 12345)
  const seriesId = parseInt(series.id.replace('series_', ''), 10);

  useEffect(() => {
    let cancelled = false;
    fetchSeriesInfo(seriesId).then(result => {
      if (cancelled) return;
      if (result) {
        setInfo(result);
        // Default to first available season
        const seasonNums = Object.keys(result.episodes).map(Number).sort((a, b) => a - b);
        if (seasonNums.length > 0) {
          setSelectedSeason(seasonNums[0]);
        }
        setLoading(false);
      } else {
        setError('Failed to load series info');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [seriesId, fetchSeriesInfo]);

  const currentEpisodes = useMemo<Episode[]>(
    () => info?.episodes[selectedSeason] || [],
    [info, selectedSeason]
  );

  const handlePlayEpisode = useCallback((episode: Episode) => {
    // Create a Channel-like object for the episode
    const episodeChannel: Channel = {
      id: `episode_${episode.id}`,
      name: `${info?.name || series.name} - S${episode.season}E${episode.episodeNum} - ${episode.title}`,
      url: episode.url,
      logo: episode.image || series.logo,
      group: series.group,
      region: '',
      contentType: 'series',
    };
    setChannel(episodeChannel);
    navigate('player');
  }, [info, series, setChannel, navigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (MOBILE) return;

    if (e.keyCode === KEY_CODES.BACK || e.keyCode === 27) {
      e.preventDefault();
      goBack();
      return;
    }

    if (e.keyCode === KEY_CODES.DOWN) {
      e.preventDefault();
      if (focusIndex < currentEpisodes.length - 1) {
        setFocusIndex(focusIndex + 1);
      }
    } else if (e.keyCode === KEY_CODES.UP) {
      e.preventDefault();
      if (focusIndex > 0) {
        setFocusIndex(focusIndex - 1);
      }
    } else if (e.keyCode === KEY_CODES.ENTER) {
      e.preventDefault();
      if (focusIndex >= 0 && focusIndex < currentEpisodes.length) {
        handlePlayEpisode(currentEpisodes[focusIndex]);
      }
    } else if (e.keyCode === KEY_CODES.LEFT) {
      e.preventDefault();
      // Switch to previous season
      if (info) {
        const seasonNums = Object.keys(info.episodes).map(Number).sort((a, b) => a - b);
        const idx = seasonNums.indexOf(selectedSeason);
        if (idx > 0) {
          setSelectedSeason(seasonNums[idx - 1]);
          setFocusIndex(0);
        }
      }
    } else if (e.keyCode === KEY_CODES.RIGHT) {
      e.preventDefault();
      // Switch to next season
      if (info) {
        const seasonNums = Object.keys(info.episodes).map(Number).sort((a, b) => a - b);
        const idx = seasonNums.indexOf(selectedSeason);
        if (idx < seasonNums.length - 1) {
          setSelectedSeason(seasonNums[idx + 1]);
          setFocusIndex(0);
        }
      }
    }
  }, [focusIndex, currentEpisodes, selectedSeason, info, handlePlayEpisode, goBack]);

  // Focus current episode on render
  useEffect(() => {
    if (MOBILE) return;
    requestAnimationFrame(() => {
      const list = episodeListRef.current;
      if (!list) return;
      const el = list.querySelector(`[data-ep-idx="${focusIndex}"]`) as HTMLElement | null;
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    });
  }, [focusIndex, selectedSeason]);

  if (loading) {
    return (
      <div className="series-detail" onKeyDown={handleKeyDown}>
        <div className="series-detail__loading">Loading series info...</div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="series-detail" onKeyDown={handleKeyDown}>
        <div className="series-detail__error">{error || 'Series not found'}</div>
        <button className="series-detail__back-btn" onClick={goBack}>Go Back</button>
      </div>
    );
  }

  const seasonNumbers = Object.keys(info.episodes).map(Number).sort((a, b) => a - b);

  // Find the "next up" episode: the first unwatched or in-progress episode
  let nextUpEpisode: Episode | null = null;
  for (const ep of currentEpisodes) {
    const progress = getWatchProgress(`episode_${ep.id}`);
    if (!progress || (progress.duration > 0 && progress.position / progress.duration < 0.95)) {
      nextUpEpisode = ep;
      break;
    }
  }

  return (
    <div className="series-detail" onKeyDown={handleKeyDown} tabIndex={-1}>
      {/* Header */}
      <div className="series-detail__header">
        <div className="series-detail__poster">
          {(info.cover || series.logo) ? (
            <img src={info.cover || series.logo} alt={info.name} />
          ) : (
            <div className="series-detail__poster-fallback">
              {info.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="series-detail__info">
          <h1 className="series-detail__title">{info.name || series.name}</h1>
          {info.genre && <span className="series-detail__genre">{info.genre}</span>}
          {info.rating && <span className="series-detail__rating">Rating: {info.rating}</span>}
          {info.releaseDate && <span className="series-detail__year">{info.releaseDate}</span>}
          {info.plot && <p className="series-detail__plot">{info.plot}</p>}
          {info.cast && <p className="series-detail__cast">Cast: {info.cast}</p>}
          {info.director && <p className="series-detail__director">Director: {info.director}</p>}
          {nextUpEpisode && (
            <button
              className="series-detail__play-btn"
              data-focusable
              tabIndex={0}
              onClick={() => handlePlayEpisode(nextUpEpisode!)}
            >
              {getWatchProgress(`episode_${nextUpEpisode.id}`)
                ? `Resume S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
                : `Play S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
              }
            </button>
          )}
        </div>
      </div>

      {/* Season tabs */}
      <div className="series-detail__seasons">
        {seasonNumbers.map(sn => (
          <button
            key={sn}
            className={`series-detail__season-tab${sn === selectedSeason ? ' series-detail__season-tab--active' : ''}`}
            onClick={() => { setSelectedSeason(sn); setFocusIndex(0); }}
            tabIndex={MOBILE ? 0 : -1}
          >
            Season {sn}
          </button>
        ))}
      </div>

      {/* Episode list */}
      <div className="series-detail__episodes" ref={episodeListRef}>
        {currentEpisodes.length === 0 ? (
          <div className="series-detail__no-episodes">No episodes available for this season.</div>
        ) : (
          currentEpisodes.map((ep, idx) => {
            const progress = getWatchProgress(`episode_${ep.id}`);
            const pct = progress && progress.duration > 0
              ? Math.round((progress.position / progress.duration) * 100)
              : 0;
            const isWatched = progress && progress.duration > 0 && progress.position / progress.duration >= 0.95;

            return (
              <div
                key={ep.id}
                className={`series-detail__episode${focusIndex === idx && !MOBILE ? ' series-detail__episode--focused' : ''}${isWatched ? ' series-detail__episode--watched' : ''}`}
                data-focusable
                data-ep-idx={idx}
                tabIndex={MOBILE ? 0 : -1}
                onClick={() => handlePlayEpisode(ep)}
              >
                <div className="series-detail__ep-thumb">
                  {ep.image ? (
                    <img src={ep.image} alt={ep.title} loading="lazy" decoding="async" />
                  ) : (
                    <div className="series-detail__ep-thumb-fallback">
                      E{ep.episodeNum}
                    </div>
                  )}
                  {pct > 0 && !isWatched && (
                    <div className="series-detail__ep-progress">
                      <div className="series-detail__ep-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="series-detail__ep-info">
                  <span className="series-detail__ep-number">E{ep.episodeNum}</span>
                  <span className="series-detail__ep-title">{ep.title}</span>
                  {ep.duration && <span className="series-detail__ep-duration">{ep.duration}</span>}
                  {ep.plot && <p className="series-detail__ep-plot">{ep.plot}</p>}
                </div>
                {isWatched && <span className="series-detail__ep-check">{'\u2713'}</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

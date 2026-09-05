import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Channel, SeriesInfo, Episode } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { getSeriesWatchProgress } from '../services/channel-service';
import { getEpisodeProgressDisplay, getSeriesEpisodeState, parseEpisodeDuration } from '../utils/episode-progress';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';
import FocusZone from './FocusZone';

const MOBILE = isMobile();

interface SeriesDetailProps {
  series: Channel;
}

export default function SeriesDetail({ series }: SeriesDetailProps) {
  const [info, setInfo] = useState<SeriesInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [seasonSelection, setSeasonSelection] = useState<{ seriesId: string; season: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  const fetchSeriesInfo = useChannelStore((s) => s.fetchSeriesInfo);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const goBack = useAppStore((s) => s.goBack);
  const isFavorite = useFavoritesStore((s) => s.favoriteIds.has(series.id));
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);

  // Extract numeric series ID from prefixed ID (e.g., "series_12345" -> 12345)
  const seriesId = parseInt(series.id.replace('series_', ''), 10);

  useEffect(() => {
    let cancelled = false;
    fetchSeriesInfo(seriesId).then(result => {
      if (cancelled) return;
      if (result) {
        setInfo(result);
        setLoading(false);
      } else {
        setError('Failed to load series info');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [seriesId, fetchSeriesInfo]);

  const seasonNumbers = useMemo(
    () => Object.keys(info?.episodes ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    [info],
  );
  const seriesProgress = useMemo(
    () => getSeriesWatchProgress(series.id),
    [series.id],
  );
  const episodeState = useMemo(
    () => getSeriesEpisodeState(info?.episodes ?? {}, id => seriesProgress[id] ?? null),
    [info, seriesProgress],
  );
  const selectedSeason = seasonSelection?.seriesId === series.id
    && seasonNumbers.includes(seasonSelection.season)
    ? seasonSelection.season
    : episodeState.recommendedSeason ?? seasonNumbers[0] ?? 1;
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
      duration: parseEpisodeDuration(episode.duration),
      seriesId: series.id,
    };
    setChannel(episodeChannel);
    navigate('player');
  }, [info, series, setChannel, navigate]);

  const selectSeason = useCallback((season: number) => {
    setSeasonSelection({ seriesId: series.id, season });
    setFocusIndex(0);
  }, [series.id]);

  const stepSeason = useCallback((offset: number) => {
    const index = seasonNumbers.indexOf(selectedSeason);
    const next = seasonNumbers[index + offset];
    if (next !== undefined) selectSeason(next);
  }, [seasonNumbers, selectedSeason, selectSeason]);

  if (loading) {
    return (
      <div className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden">
        <div className="flex items-center justify-center h-[300px] text-20 text-[#888]">Loading series info...</div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <FocusZone className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden" onBack={goBack}>
        <div className="flex items-center justify-center h-[300px] text-20 text-[#888]">{error || 'Series not found'}</div>
        <button data-focusable tabIndex={0} className="block mx-auto my-5 py-2.5 px-6 bg-[#333] text-white border-none rounded-md text-base cursor-pointer" onClick={goBack}>Go Back</button>
      </FocusZone>
    );
  }

  const nextUpEpisode = episodeState.nextUp;
  const nextUpProgress = nextUpEpisode ? seriesProgress[`episode_${nextUpEpisode.id}`] ?? null : null;
  const nextUpDisplay = nextUpEpisode && nextUpProgress
    ? getEpisodeProgressDisplay(
      nextUpProgress.position,
      nextUpProgress.duration,
      nextUpEpisode.duration,
      nextUpProgress.completed === true,
    )
    : null;

  return (
    <FocusZone className="p-4 pb-[calc(72px+env(safe-area-inset-bottom,0px))] lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden" onBack={goBack}>
      {MOBILE && (
        <button
          data-focusable
          tabIndex={0}
          className="inline-flex items-center gap-1.5 py-2 px-4 bg-white/[0.08] border-none rounded-lg text-[#ccc] text-sm mb-4 tap-none active:bg-white/[0.16] focus:outline-2 focus:outline-accent focus:outline-offset-2"
          onClick={goBack}
        >
          {'\u2190'} Back
        </button>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-7 lg:mb-7">
        <div className="w-full max-w-[180px] h-[252px] mx-auto lg:w-[220px] lg:min-w-[220px] lg:h-[320px] lg:max-w-none lg:mx-0 rounded-[10px] overflow-hidden bg-surface-border">
          {(info.cover || series.logo) ? (
            <img className="w-full h-full object-cover" src={info.cover || series.logo} alt={info.name} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-64 font-bold text-white bg-gradient-to-br from-[#6c5ce7] to-[#e84393]">
              {info.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 text-center lg:text-left lg:flex-1 lg:min-w-0">
          <h1 className="text-22 lg:text-32 font-bold text-white leading-tight">{info.name || series.name}</h1>
          <button
            className={cn(
              'self-center lg:self-start py-2 px-4 rounded-lg border text-sm font-semibold transition-colors',
              isFavorite ? 'bg-favorite/20 border-favorite text-favorite' : 'bg-surface border-surface-border text-[#ccc] hover:border-favorite'
            )}
            data-focusable
            tabIndex={0}
            onClick={() => toggleFavorite(series.id)}
          >
            {isFavorite ? '★ Favorited' : '☆ Add to Favorites'}
          </button>
          {info.genre && <span className="text-15 text-[#9ca3af]">{info.genre}</span>}
          {info.rating && <span className="text-15 text-rating">Rating: {info.rating}</span>}
          {info.releaseDate && <span className="text-15 text-[#9ca3af]">{info.releaseDate}</span>}
          {info.plot && <p className="text-13 line-clamp-4 lg:text-15 lg:line-clamp-5 text-[#b0b8c4] leading-relaxed mt-1">{info.plot}</p>}
          {info.cast && <p className="text-13 text-[#7a8290]">Cast: {info.cast}</p>}
          {info.director && <p className="text-13 text-[#7a8290]">Director: {info.director}</p>}
          {nextUpEpisode && (
            <button
              className="mt-3 py-2.5 px-6 lg:py-3 lg:px-8 bg-brand-red text-white border-none rounded-md text-15 lg:text-18 font-semibold cursor-pointer self-start transition-colors duration-150 hover:bg-brand-red-hover focus:bg-brand-red-hover focus:outline-hidden"
              data-focusable
              tabIndex={0}
              onClick={() => handlePlayEpisode(nextUpEpisode!)}
            >
              {nextUpDisplay && !nextUpDisplay.completed
                ? `Resume S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
                : `Play S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
              }
            </button>
          )}
          {episodeState.allCompleted && (
            <span className="mt-3 text-15 font-semibold text-success self-center lg:self-start">All episodes watched</span>
          )}
        </div>
      </div>

      {/* Compact native selector on touch layouts; scrollable chips with
          explicit arrows on desktop/TV so large catalogs remain reachable. */}
      {MOBILE && (
        <label className="flex flex-col gap-1.5 mb-5 text-12 font-semibold text-[#9ca3af]">
          Season
          <select
            className="h-11 w-full px-3 bg-surface-border border border-white/15 rounded-lg text-white text-sm focus:border-accent focus:outline-2 focus:outline-accent focus:outline-offset-2"
            value={selectedSeason}
            onChange={(event) => selectSeason(Number(event.target.value))}
            data-focusable
          >
            {seasonNumbers.map(season => (
              <option key={season} value={season}>Season {season}</option>
            ))}
          </select>
        </label>
      )}

      {!MOBILE && (
        <div className="flex items-center gap-3 mb-5 max-w-[560px]">
          <button
            className={cn(
              'w-10 h-10 shrink-0 rounded-lg bg-surface-border border border-white/10 text-white focus:outline-2 focus:outline-accent focus:outline-offset-2',
              seasonNumbers.indexOf(selectedSeason) <= 0 && 'opacity-25',
            )}
            onClick={() => stepSeason(-1)}
            aria-disabled={seasonNumbers.indexOf(selectedSeason) <= 0}
            aria-label="Previous season"
            data-focusable
          >
            {'\u2039'}
          </button>
          <select
            className="h-10 flex-1 min-w-0 px-3 bg-surface-border border-2 border-brand-red rounded-lg text-white text-15 focus:outline-2 focus:outline-accent focus:outline-offset-2"
            value={selectedSeason}
            onChange={(event) => selectSeason(Number(event.target.value))}
            aria-label="Season"
            data-focusable
          >
            {seasonNumbers.map(season => (
              <option key={season} value={season}>Season {season}</option>
            ))}
          </select>
          <span className="text-13 text-[#7a8290] whitespace-nowrap" aria-hidden="true">
            {seasonNumbers.indexOf(selectedSeason) + 1} / {seasonNumbers.length}
          </span>
          <button
            className={cn(
              'w-10 h-10 shrink-0 rounded-lg bg-surface-border border border-white/10 text-white focus:outline-2 focus:outline-accent focus:outline-offset-2',
              seasonNumbers.indexOf(selectedSeason) >= seasonNumbers.length - 1 && 'opacity-25',
            )}
            onClick={() => stepSeason(1)}
            aria-disabled={seasonNumbers.indexOf(selectedSeason) >= seasonNumbers.length - 1}
            aria-label="Next season"
            data-focusable
          >
            {'\u203A'}
          </button>
        </div>
      )}

      {/* Episode list */}
      <div className="flex flex-col gap-1.5">
        {currentEpisodes.length === 0 ? (
          <div className="p-10 text-center text-[#666] text-base">No episodes available for this season.</div>
        ) : (
          currentEpisodes.map((ep, idx) => {
            const progress = seriesProgress[`episode_${ep.id}`] ?? null;
            const progressDisplay = progress
              ? getEpisodeProgressDisplay(progress.position, progress.duration, ep.duration, progress.completed === true)
              : null;
            const pct = progressDisplay?.percent ?? 0;
            const isWatched = progressDisplay?.completed === true;

            return (
              <div
                key={ep.id}
                className={cn(
                  'flex flex-col p-0 gap-0 overflow-hidden lg:flex-row lg:items-center lg:gap-4 lg:p-3 lg:px-4 bg-surface-episode rounded-lg cursor-pointer transition-all duration-150 outline-2 outline-transparent hover:bg-surface-episode-hover',
                  focusIndex === idx && !MOBILE && 'bg-surface-episode-hover outline-brand-red',
                  isWatched && 'opacity-60'
                )}
                data-focusable
                data-ep-idx={idx}
                tabIndex={0}
                onFocus={() => setFocusIndex(idx)}
                onClick={() => handlePlayEpisode(ep)}
              >
                <div className="w-full min-w-full h-[160px] rounded-t-lg rounded-b-none lg:w-[160px] lg:min-w-[160px] lg:h-[90px] lg:rounded-md overflow-hidden bg-surface-border relative">
                  {ep.image ? (
                    <img className="w-full h-full object-cover" src={ep.image} alt={ep.title} loading="lazy" decoding="async" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-24 font-bold text-[#666]">
                      E{ep.episodeNum}
                    </div>
                  )}
                  {pct > 0 && !isWatched && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                      <div className="h-full bg-brand-red rounded-sm" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="p-2.5 px-3 pb-3 lg:p-0 flex-1 min-w-0 flex flex-col gap-1">
                  <span className="text-13 text-[#9ca3af] font-semibold">E{ep.episodeNum}</span>
                  <span className="text-sm whitespace-normal lg:text-17 text-white font-medium lg:whitespace-nowrap overflow-hidden text-ellipsis">{ep.title}</span>
                  {ep.duration && <span className="text-13 text-[#7a8290]">{ep.duration}</span>}
                  {progressDisplay && !isWatched && <span className="text-13 font-semibold text-brand-red">{progressDisplay.label}</span>}
                  {ep.plot && <p className="text-12 lg:text-13 text-[#7a8290] leading-snug line-clamp-2">{ep.plot}</p>}
                </div>
                {isWatched && <span className="text-22 text-success ml-auto pr-2">{'\u2713'}</span>}
              </div>
            );
          })
        )}
      </div>
    </FocusZone>
  );
}

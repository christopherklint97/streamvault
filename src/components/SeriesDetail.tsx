import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Channel, SeriesInfo, Episode } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { getWatchProgress } from '../services/channel-service';
import { KEY_CODES } from '../utils/keys';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';

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
      <div className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden" onKeyDown={handleKeyDown}>
        <div className="flex items-center justify-center h-[300px] text-20 text-[#888]">Loading series info...</div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden" onKeyDown={handleKeyDown}>
        <div className="flex items-center justify-center h-[300px] text-20 text-[#888]">{error || 'Series not found'}</div>
        <button className="block mx-auto my-5 py-2.5 px-6 bg-[#333] text-white border-none rounded-md text-base cursor-pointer" onClick={goBack}>Go Back</button>
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
    <div className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden" onKeyDown={handleKeyDown} tabIndex={-1}>
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-7 lg:mb-7">
        <div className="w-full max-w-[200px] h-[280px] mx-auto lg:w-[220px] lg:min-w-[220px] lg:h-[320px] lg:max-w-none lg:mx-0 rounded-[10px] overflow-hidden bg-surface-border">
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
              {getWatchProgress(`episode_${nextUpEpisode.id}`)
                ? `Resume S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
                : `Play S${nextUpEpisode.season}E${nextUpEpisode.episodeNum}`
              }
            </button>
          )}
        </div>
      </div>

      {/* Season tabs */}
      <div className="flex gap-2 lg:gap-2.5 mb-5 overflow-x-auto pb-1 flex-wrap lg:flex-nowrap">
        {seasonNumbers.map(sn => (
          <button
            key={sn}
            className={cn(
              'py-1.5 px-3.5 lg:py-2 lg:px-[18px] text-[#b0b8c4] border-2 border-transparent rounded-lg text-13 lg:text-15 cursor-pointer whitespace-nowrap transition-all duration-150 hover:bg-[#252542] hover:text-white',
              sn === selectedSeason ? 'bg-[#252542] text-white border-brand-red' : 'bg-surface-border'
            )}
            onClick={() => { setSelectedSeason(sn); setFocusIndex(0); }}
            tabIndex={MOBILE ? 0 : -1}
          >
            Season {sn}
          </button>
        ))}
      </div>

      {/* Episode list */}
      <div className="flex flex-col gap-1.5" ref={episodeListRef}>
        {currentEpisodes.length === 0 ? (
          <div className="p-10 text-center text-[#666] text-base">No episodes available for this season.</div>
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
                className={cn(
                  'flex flex-col p-0 gap-0 overflow-hidden lg:flex-row lg:items-center lg:gap-4 lg:p-3 lg:px-4 bg-surface-episode rounded-lg cursor-pointer transition-all duration-150 outline-2 outline-transparent hover:bg-surface-episode-hover',
                  focusIndex === idx && !MOBILE && 'bg-surface-episode-hover outline-brand-red',
                  isWatched && 'opacity-60'
                )}
                data-focusable
                data-ep-idx={idx}
                tabIndex={MOBILE ? 0 : -1}
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
                  {ep.plot && <p className="text-12 lg:text-13 text-[#7a8290] leading-snug line-clamp-2">{ep.plot}</p>}
                </div>
                {isWatched && <span className="text-22 text-success ml-auto pr-2">{'\u2713'}</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Channel, MovieInfo } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { getWatchProgress } from '../services/channel-service';
import { cn } from '../utils/cn';

interface MovieDetailProps {
  movie: Channel;
}

export default function MovieDetail({ movie }: MovieDetailProps) {
  const [info, setInfo] = useState<MovieInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchMovieInfo = useChannelStore((s) => s.fetchMovieInfo);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const goBack = useAppStore((s) => s.goBack);
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useFavoritesStore((s) => s.favoriteIds.has(movie.id));
  const lists = useFavoritesStore((s) => s.lists);
  const addToList = useFavoritesStore((s) => s.addToList);
  const removeFromList = useFavoritesStore((s) => s.removeFromList);
  const [showListMenu, setShowListMenu] = useState(false);

  // Extract numeric VOD ID from channel ID (e.g., "movie_12345" -> 12345)
  const vodId = useMemo(() => parseInt(movie.id.replace('movie_', ''), 10), [movie.id]);

  useEffect(() => {
    if (isNaN(vodId)) return;
    let cancelled = false;
    fetchMovieInfo(vodId).then(result => {
      if (cancelled) return;
      setInfo(result);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [vodId, fetchMovieInfo]);

  const handlePlay = useCallback(() => {
    setChannel(movie);
    navigate('player');
  }, [movie, setChannel, navigate]);

  const progress = getWatchProgress(movie.id);
  const pct = progress && progress.duration > 0
    ? Math.round((progress.position / progress.duration) * 100)
    : 0;

  const cover = info?.cover || movie.logo;
  const title = info?.name || movie.name;

  return (
    <div className="p-4 lg:p-6 lg:px-8 overflow-y-auto h-full outline-hidden">
      <button className="inline-flex items-center gap-1.5 py-2 px-4 bg-white/[0.08] border-none rounded-lg text-[#ccc] text-sm mb-4 tap-none active:bg-white/[0.16] lg:hidden" onClick={goBack}>
        {'\u2190'} Back
      </button>

      <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-start lg:gap-7 lg:mb-7">
        <div className="w-[200px] h-[300px] rounded-xl overflow-hidden bg-surface-border shrink-0 lg:w-[220px] lg:min-w-[220px] lg:h-[320px] lg:rounded-[10px]">
          {cover ? (
            <img className="w-full h-full object-cover" src={cover} alt={title} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-64 font-bold text-white bg-gradient-to-br from-[#6c5ce7] to-[#e84393]">
              {title.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 text-center w-full lg:text-left lg:flex-1 lg:min-w-0">
          <h1 className="text-22 lg:text-32 font-bold text-white leading-tight">{title}</h1>
          {info?.genre && <span className="text-sm lg:text-15 text-[#9ca3af]">{info.genre}</span>}
          <div className="flex gap-3 justify-center flex-wrap lg:justify-start lg:gap-4">
            {info?.rating && <span className="text-sm lg:text-15 text-rating font-semibold">{info.rating}</span>}
            {info?.releaseDate && <span className="text-sm lg:text-15 text-[#9ca3af]">{info.releaseDate}</span>}
            {info?.duration && <span className="text-sm lg:text-15 text-[#9ca3af]">{info.duration}</span>}
          </div>
          {info?.plot && <p className="text-sm lg:text-15 text-[#b0b8c4] leading-relaxed text-left lg:mt-1">{info.plot}</p>}
          {info?.cast && <p className="text-13 text-[#7a8290] text-left">Cast: {info.cast}</p>}
          {info?.director && <p className="text-13 text-[#7a8290] text-left">Director: {info.director}</p>}
          {!info && !loading && (
            <p className="text-sm lg:text-15 text-[#555]">{movie.group}</p>
          )}

          <div className="flex gap-2.5 justify-center flex-wrap mt-2 lg:justify-start lg:gap-3 lg:mt-3">
            <button className="py-3 px-8 bg-brand-red text-white border-none rounded-lg text-base lg:text-18 font-semibold tap-none active:opacity-80 hover:bg-brand-red-hover focus:bg-brand-red-hover focus:outline-hidden" onClick={handlePlay}>
              {pct > 0 && pct < 95 ? `Resume (${pct}%)` : 'Play'}
            </button>
            <button
              className={cn(
                'py-3 px-5 lg:px-6 bg-white/[0.08] border border-white/[0.15] rounded-lg text-sm lg:text-base tap-none hover:border-favorite hover:text-favorite',
                isFavorite ? 'text-favorite border-favorite' : 'text-[#ccc]'
              )}
              onClick={() => toggleFavorite(movie.id)}
            >
              {isFavorite ? '\u2605 Favorited' : '\u2606 Favorite'}
            </button>
            {lists.length > 0 && (
              <div className="relative">
                <button
                  className="py-3 px-5 lg:px-6 bg-white/[0.08] text-[#ccc] border border-white/[0.15] rounded-lg text-sm lg:text-base tap-none hover:border-accent"
                  onClick={() => setShowListMenu(!showListMenu)}
                >
                  + Add to List
                </button>
                {showListMenu && (
                  <div className="absolute bottom-[calc(100%+8px)] left-1/2 lg:left-0 -translate-x-1/2 lg:translate-x-0 bg-surface-border border border-white/10 rounded-[10px] p-1.5 min-w-[180px] lg:min-w-[200px] z-20 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                    {lists.map(list => {
                      const inList = list.channelIds.includes(movie.id);
                      return (
                        <button
                          key={list.id}
                          className={cn(
                            'block w-full py-2.5 px-3.5 bg-transparent border-none rounded-md text-left text-sm lg:text-15 tap-none active:bg-white/[0.08] hover:bg-white/[0.08]',
                            inList ? 'text-success' : 'text-[#ccc]'
                          )}
                          onClick={() => {
                            if (inList) removeFromList(list.id, movie.id);
                            else addToList(list.id, movie.id);
                          }}
                        >
                          {inList ? '\u2713 ' : ''}{list.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {pct > 0 && pct < 95 && (
            <div className="h-1 bg-white/[0.15] rounded-sm mt-2 lg:mt-3 lg:max-w-[400px]">
              <div className="h-full bg-brand-red rounded-sm" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>

      {loading && <div className="text-center p-5 lg:p-10 text-[#888] text-sm lg:text-18">Loading movie info...</div>}
    </div>
  );
}

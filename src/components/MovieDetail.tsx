import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Channel, MovieInfo } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useFavoritesStore } from '../stores/favoritesStore';
import { getWatchProgress } from '../services/channel-service';

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
    <div className="movie-detail">
      <button className="movie-detail__back" onClick={goBack}>
        {'\u2190'} Back
      </button>

      <div className="movie-detail__header">
        <div className="movie-detail__poster">
          {cover ? (
            <img src={cover} alt={title} />
          ) : (
            <div className="movie-detail__poster-fallback">
              {title.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="movie-detail__info">
          <h1 className="movie-detail__title">{title}</h1>
          {info?.genre && <span className="movie-detail__genre">{info.genre}</span>}
          <div className="movie-detail__meta">
            {info?.rating && <span className="movie-detail__rating">{info.rating}</span>}
            {info?.releaseDate && <span className="movie-detail__year">{info.releaseDate}</span>}
            {info?.duration && <span className="movie-detail__duration">{info.duration}</span>}
          </div>
          {info?.plot && <p className="movie-detail__plot">{info.plot}</p>}
          {info?.cast && <p className="movie-detail__cast">Cast: {info.cast}</p>}
          {info?.director && <p className="movie-detail__director">Director: {info.director}</p>}
          {!info && !loading && (
            <p className="movie-detail__group">{movie.group}</p>
          )}

          <div className="movie-detail__actions">
            <button className="movie-detail__play-btn" onClick={handlePlay}>
              {pct > 0 && pct < 95 ? `Resume (${pct}%)` : 'Play'}
            </button>
            <button
              className={`movie-detail__fav-btn${isFavorite ? ' movie-detail__fav-btn--active' : ''}`}
              onClick={() => toggleFavorite(movie.id)}
            >
              {isFavorite ? '\u2605 Favorited' : '\u2606 Favorite'}
            </button>
            {lists.length > 0 && (
              <div className="movie-detail__list-menu-wrap">
                <button
                  className="movie-detail__list-btn"
                  onClick={() => setShowListMenu(!showListMenu)}
                >
                  + Add to List
                </button>
                {showListMenu && (
                  <div className="movie-detail__list-menu">
                    {lists.map(list => {
                      const inList = list.channelIds.includes(movie.id);
                      return (
                        <button
                          key={list.id}
                          className={`movie-detail__list-item${inList ? ' movie-detail__list-item--active' : ''}`}
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
            <div className="movie-detail__progress-bar">
              <div className="movie-detail__progress-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>

      {loading && <div className="movie-detail__loading">Loading movie info...</div>}
    </div>
  );
}

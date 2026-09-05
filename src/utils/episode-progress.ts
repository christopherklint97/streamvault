import type { Episode, WatchProgress } from '../types';

export interface EpisodeProgressDisplay {
  percent: number;
  label: string;
  completed: boolean;
}

export interface SeriesEpisodeState {
  nextUp: Episode | null;
  recommendedSeason: number | null;
  hasEpisodes: boolean;
  allCompleted: boolean;
}

export function parseEpisodeDuration(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) return undefined;
  const values = parts.map(Number);
  if (values.some(part => !Number.isFinite(part) || part < 0)) return undefined;
  if (values[values.length - 1] >= 60) return undefined;
  if (values.length === 3 && values[1] >= 60) return undefined;
  return values.reduce((total, part) => total * 60 + part, 0);
}

function formatSeconds(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function getEpisodeProgressDisplay(
  position: number,
  savedDuration: number,
  episodeDuration: string,
  explicitlyCompleted = false,
): EpisodeProgressDisplay | null {
  if (explicitlyCompleted) return { percent: 100, label: 'Watched', completed: true };
  if (!Number.isFinite(position) || position < 10) return null;

  const duration = Number.isFinite(savedDuration) && savedDuration > 0
    ? savedDuration
    : parseEpisodeDuration(episodeDuration);
  if (!duration || duration <= 0) {
    return { percent: 0, label: `Resume ${formatSeconds(position)}`, completed: false };
  }

  const ratio = position / duration;
  const completed = ratio >= 0.95;
  const percent = Math.min(100, Math.floor(ratio * 100));
  return completed
    ? { percent: 100, label: 'Watched', completed: true }
    : { percent, label: `Resume ${formatSeconds(position)} · ${percent}%`, completed: false };
}

function orderedEpisodes(episodes: Record<number, Episode[]>): Episode[] {
  return Object.keys(episodes)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .flatMap(season => [...(episodes[season] || [])].sort((a, b) => a.episodeNum - b.episodeNum));
}

function episodeIsCompleted(episode: Episode, saved: WatchProgress | null): boolean {
  if (!saved) return false;
  return getEpisodeProgressDisplay(
    saved.position,
    saved.duration,
    episode.duration,
    saved.completed === true,
  )?.completed === true;
}

export function getSeriesEpisodeState(
  episodes: Record<number, Episode[]>,
  getProgress: (channelId: string) => WatchProgress | null,
): SeriesEpisodeState {
  const ordered = orderedEpisodes(episodes);
  if (ordered.length === 0) {
    return { nextUp: null, recommendedSeason: null, hasEpisodes: false, allCompleted: false };
  }

  const withProgress = ordered.map(episode => ({
    episode,
    progress: getProgress(`episode_${episode.id}`),
  }));

  const latestInProgress = withProgress
    .filter(({ episode, progress }) => Boolean(
      progress
      && progress.position >= 10
      && !episodeIsCompleted(episode, progress),
    ))
    .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0))[0];
  if (latestInProgress) {
    return {
      nextUp: latestInProgress.episode,
      recommendedSeason: latestInProgress.episode.season,
      hasEpisodes: true,
      allCompleted: false,
    };
  }

  const nextUp = withProgress
    .find(({ episode, progress }) => !episodeIsCompleted(episode, progress))
    ?.episode ?? null;
  const recommendedSeason = nextUp?.season
    ?? withProgress[withProgress.length - 1].episode.season;

  return { nextUp, recommendedSeason, hasEpisodes: true, allCompleted: nextUp === null };
}

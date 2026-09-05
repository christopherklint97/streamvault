import { describe, expect, it } from 'vitest';
import type { Episode, WatchProgress } from '../../types';
import {
  getEpisodeProgressDisplay,
  getSeriesEpisodeState,
  parseEpisodeDuration,
} from '../episode-progress';

function episode(id: string, season: number, episodeNum: number, duration = '00:50:00'): Episode {
  return {
    id,
    season,
    episodeNum,
    duration,
    title: `Episode ${episodeNum}`,
    url: `http://provider.example/${id}.mkv`,
    containerExtension: 'mkv',
    plot: '',
    image: '',
    rating: 0,
  };
}

function progress(channelId: string, position: number, duration: number, updatedAt: number, completed = false): WatchProgress {
  return {
    channelId,
    position,
    duration,
    updatedAt,
    contentType: 'series',
    seriesId: 'series_2963',
    completed,
  };
}

describe('parseEpisodeDuration', () => {
  it('parses provider HH:MM:SS and MM:SS values', () => {
    expect(parseEpisodeDuration('00:57:34')).toBe(3454);
    expect(parseEpisodeDuration('57:35')).toBe(3455);
  });

  it('rejects malformed durations', () => {
    expect(parseEpisodeDuration('')).toBeUndefined();
    expect(parseEpisodeDuration('1:99')).toBeUndefined();
    expect(parseEpisodeDuration('unknown')).toBeUndefined();
  });
});

describe('getEpisodeProgressDisplay', () => {
  it('uses provider episode duration when iPhone HLS saved an unknown duration', () => {
    expect(getEpisodeProgressDisplay(420, 0, '57:35')).toEqual({
      percent: 12,
      label: 'Resume 7:00 · 12%',
      completed: false,
    });
  });

  it('shows watched time without a percentage when duration is unavailable', () => {
    expect(getEpisodeProgressDisplay(420, 0, '')).toEqual({
      percent: 0,
      label: 'Resume 7:00',
      completed: false,
    });
  });

  it('honors an explicit completed episode even when duration is unavailable', () => {
    expect(getEpisodeProgressDisplay(420, 0, '', true)).toEqual({
      percent: 100,
      label: 'Watched',
      completed: true,
    });
  });

  it('does not mark 94.5 percent complete by rounding it to 95', () => {
    expect(getEpisodeProgressDisplay(945, 1000, '')).toEqual({
      percent: 94,
      label: 'Resume 15:45 · 94%',
      completed: false,
    });
  });
});

describe('getSeriesEpisodeState', () => {
  const episodes = {
    1: [episode('101', 1, 1), episode('102', 1, 2)],
    2: [episode('201', 2, 1), episode('202', 2, 2)],
  };

  it('resumes the most recently watched unfinished episode across seasons', () => {
    const saved = new Map<string, WatchProgress>([
      ['episode_102', progress('episode_102', 600, 3000, 10)],
      ['episode_201', progress('episode_201', 900, 3000, 20)],
    ]);

    const state = getSeriesEpisodeState(episodes, id => saved.get(id) ?? null);

    expect(state.nextUp?.id).toBe('201');
    expect(state.recommendedSeason).toBe(2);
  });

  it('selects the episode after the furthest completed episode', () => {
    const saved = new Map<string, WatchProgress>([
      ['episode_101', progress('episode_101', 3000, 3000, 10, true)],
      ['episode_102', progress('episode_102', 3000, 3000, 20, true)],
    ]);

    const state = getSeriesEpisodeState(episodes, id => saved.get(id) ?? null);

    expect(state.nextUp?.id).toBe('201');
    expect(state.recommendedSeason).toBe(2);
  });

  it('starts at the first episode when there is no history', () => {
    const state = getSeriesEpisodeState(episodes, () => null);

    expect(state.nextUp?.id).toBe('101');
    expect(state.recommendedSeason).toBe(1);
  });

  it('returns an unwatched gap before a later completed episode', () => {
    const saved = new Map<string, WatchProgress>([
      ['episode_102', progress('episode_102', 3000, 3000, 20, true)],
    ]);

    const state = getSeriesEpisodeState(episodes, id => saved.get(id) ?? null);

    expect(state.nextUp?.id).toBe('101');
    expect(state.allCompleted).toBe(false);
  });

  it('reports completion when every episode is watched', () => {
    const saved = new Map<string, WatchProgress>(
      Object.values(episodes).flat().map((ep, index) => [
        `episode_${ep.id}`,
        progress(`episode_${ep.id}`, 3000, 3000, index, true),
      ]),
    );

    const state = getSeriesEpisodeState(episodes, id => saved.get(id) ?? null);

    expect(state.nextUp).toBeNull();
    expect(state.recommendedSeason).toBe(2);
    expect(state.allCompleted).toBe(true);
  });

  it('distinguishes an empty catalog from a fully watched series', () => {
    const state = getSeriesEpisodeState({}, () => null);

    expect(state.nextUp).toBeNull();
    expect(state.hasEpisodes).toBe(false);
    expect(state.allCompleted).toBe(false);
  });
});

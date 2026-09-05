import { beforeEach, describe, expect, it } from 'vitest';
import { parseUrl, updateUrl } from '../url-state';

beforeEach(() => {
  history.replaceState({}, '', '/');
});

describe('series detail URL state', () => {
  it('encodes and restores the selected parent series', () => {
    updateUrl('seriesDetail', undefined, 'series_2963');

    expect(window.location.search).toBe('?view=seriesDetail&series=series_2963');
    expect(parseUrl()).toMatchObject({
      view: 'seriesDetail',
      selectedSeriesId: 'series_2963',
    });
  });

  it('ignores a stray series ID outside the detail view', () => {
    history.replaceState({}, '', '/?series=series_2963');

    expect(parseUrl()).toMatchObject({ view: 'home', selectedSeriesId: null });
  });

  it('falls back home when a series detail URL has no selected series', () => {
    history.replaceState({}, '', '/?view=seriesDetail');

    expect(parseUrl()).toMatchObject({
      view: 'home',
      selectedSeriesId: null,
    });
  });
});

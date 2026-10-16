import { describe, expect, it } from 'vitest';
import { channelSourceRef, episodeSourceRef, resolveSourceRef } from './source-ref.js';

const resolvers = {
  channelUrl: (id: string) => (id === 'vod_1' ? 'http://provider/movie/u/p/1.mkv' : undefined),
  episodeUrl: (id: number, ext?: string) => `http://provider/series/u/p/${id}${ext ? `.${ext}` : ''}`,
};

describe('source references', () => {
  it('hides provider URLs behind references', () => {
    expect(channelSourceRef('vod_1', 'http://provider/movie/u/p/1.mkv')).toBe('streamvault:vod_1');
    expect(channelSourceRef('series_9', '')).toBe('');
    expect(episodeSourceRef('42', 'mkv')).toBe('streamvault:episode/42.mkv');
    expect(episodeSourceRef(42, 'bad/ext')).toBe('streamvault:episode/42');
  });

  it('resolves references and passes legacy URLs through', () => {
    expect(resolveSourceRef('streamvault:vod_1', resolvers)).toBe('http://provider/movie/u/p/1.mkv');
    expect(resolveSourceRef('streamvault:episode/42.mkv', resolvers)).toBe('http://provider/series/u/p/42.mkv');
    expect(resolveSourceRef('streamvault:missing', resolvers)).toBeUndefined();
    expect(resolveSourceRef('streamvault:episode/x.mkv', resolvers)).toBeUndefined();
    expect(resolveSourceRef('http://provider/series/u/p/7.mp4', resolvers)).toBe('http://provider/series/u/p/7.mp4');
  });
});

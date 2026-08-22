import { describe, expect, it } from 'vitest';
import { selectIosVodFallback } from './ios-vod';

const fourK = { id: 'vod_4k', name: 'EN - The Invite - 2026 [4K]' };
const hd = { id: 'vod_hd', name: 'EN - The Invite - 2026' };

describe('selectIosVodFallback', () => {
  it('selects the exact non-4K edition for iPhone playback', () => {
    expect(selectIosVodFallback(fourK, [fourK, hd])).toBe(hd);
  });

  it('keeps the requested VOD when a matching edition is unavailable', () => {
    expect(selectIosVodFallback(fourK, [fourK])).toBe(fourK);
  });
});

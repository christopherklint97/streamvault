import { describe, expect, it } from 'vitest';
import { toAbsolutePlayerUrl } from '../stream-url';

describe('toAbsolutePlayerUrl', () => {
  it('turns a same-origin proxy path into an absolute URL for AVPlay', () => {
    expect(toAbsolutePlayerUrl('/api/stream/vod_1467994', '', 'http://192.168.1.5:3002')).toBe(
      'http://192.168.1.5:3002/api/stream/vod_1467994'
    );
  });

  it('preserves an explicitly configured server URL', () => {
    expect(toAbsolutePlayerUrl('/api/stream/vod_1467994', 'http://media.example:3002', 'http://192.168.1.5:3002')).toBe(
      'http://media.example:3002/api/stream/vod_1467994'
    );
  });
});

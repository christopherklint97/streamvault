import { describe, it, expect } from 'vitest';
import type { Channel } from '../../types';
import { searchChannels } from '../channel-service';

const makeChannel = (name: string, group: string, region: string): Channel => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  url: `http://example.com/${name}`,
  logo: '',
  group,
  region,
  contentType: 'livetv',
});

const channels: Channel[] = [
  makeChannel('BBC One', 'News', 'UK'),
  makeChannel('CNN', 'News', 'US'),
  makeChannel('ESPN', 'Sports', 'US'),
  makeChannel('Sky Sports', 'Sports', 'UK'),
  makeChannel('Discovery', 'Entertainment', 'US'),
];

describe('searchChannels', () => {
  it('returns all channels for empty query', () => {
    expect(searchChannels(channels, '')).toEqual(channels);
  });

  it('returns all channels for whitespace-only query', () => {
    expect(searchChannels(channels, '   ')).toEqual(channels);
  });

  it('matches by name (single term)', () => {
    const result = searchChannels(channels, 'espn');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ESPN');
  });

  it('matches by group (single term)', () => {
    const result = searchChannels(channels, 'sports');
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toEqual(['ESPN', 'Sky Sports']);
  });

  it('matches by region (single term)', () => {
    const result = searchChannels(channels, 'uk');
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toEqual(['BBC One', 'Sky Sports']);
  });

  it('supports multi-word search (all terms must match)', () => {
    const result = searchChannels(channels, 'sports uk');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Sky Sports');
  });

  it('is case insensitive', () => {
    const result = searchChannels(channels, 'BBC');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('BBC One');
  });

  it('returns empty array when no matches', () => {
    const result = searchChannels(channels, 'nonexistent');
    expect(result).toHaveLength(0);
  });
});

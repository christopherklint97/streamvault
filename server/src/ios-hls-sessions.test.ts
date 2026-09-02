import { describe, expect, it } from 'vitest';
import { iosHlsSessionLimitReason, selectIosHlsSessionsToRetire } from './ios-hls-sessions';

describe('selectIosHlsSessionsToRetire', () => {
  it('retires the previous session when the same channel is restarted', () => {
    const sessions = new Map([
      ['old-movie', { channelId: 'vod_1', createdAt: 0, expiresAt: 300 }],
      ['other', { channelId: 'episode_2', createdAt: 0, expiresAt: 200 }],
    ]);
    expect(selectIosHlsSessionsToRetire(sessions, 'vod_1', 2)).toEqual(['old-movie']);
  });

  it('evicts the oldest session before exceeding the global cap', () => {
    const sessions = new Map([
      ['oldest', { channelId: 'episode_1', createdAt: 0, expiresAt: 100 }],
      ['newest', { channelId: 'episode_2', createdAt: 0, expiresAt: 200 }],
    ]);
    expect(selectIosHlsSessionsToRetire(sessions, 'vod_3', 2)).toEqual(['oldest']);
  });

  it('enforces hard lifetime and storage quotas even while active', () => {
    const session = { channelId: 'vod_1', createdAt: 100, expiresAt: 1_000 };
    expect(iosHlsSessionLimitReason(session, 701, 10, 600, 100)).toBe('lifetime');
    expect(iosHlsSessionLimitReason(session, 200, 101, 600, 100)).toBe('storage');
    expect(iosHlsSessionLimitReason(session, 200, 10, 600, 100)).toBeNull();
  });
});

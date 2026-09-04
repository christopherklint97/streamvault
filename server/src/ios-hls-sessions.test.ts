import { describe, expect, it } from 'vitest';
import { IOS_HLS_IDLE_TIMEOUT_MS, findReusableIosHlsSession, iosHlsProcessExitState, iosHlsSessionKey, iosHlsSessionLimitReason, selectIosHlsSessionsToRetire } from './ios-hls-sessions';

describe('iOS HLS session lifetime', () => {
  it('keeps prefetched movie segments available across Safari buffer gaps', () => {
    const observedSafariBufferGapMs = 4 * 60_000;
    expect(IOS_HLS_IDLE_TIMEOUT_MS).toBeGreaterThan(observedSafariBufferGapMs);
  });
});

describe('iOS HLS session reuse', () => {
  it('reuses active preparation for the same source and start position', () => {
    const key = iosHlsSessionKey('episode_177574', 'http://provider.example/episode.mkv', 0);
    const sessions = new Map([['session-1', { key, expiresAt: Date.now() + 60_000 }]]);
    expect(findReusableIosHlsSession(sessions, key)).toBe('session-1');
  });

  it('does not reuse an expired or differently-seeked stream', () => {
    const key = iosHlsSessionKey('episode_177574', 'http://provider.example/episode.mkv', 0);
    const sessions = new Map([
      ['expired', { key, expiresAt: Date.now() - 1 }],
      ['seeked', { key: iosHlsSessionKey('episode_177574', 'http://provider.example/episode.mkv', 120), expiresAt: Date.now() + 60_000 }],
    ]);
    expect(findReusableIosHlsSession(sessions, key)).toBeNull();
  });

  it('starts a replacement instead of reusing a failed FFmpeg session', () => {
    const key = iosHlsSessionKey('vod_83608', 'http://provider.example/movie.mkv', 0);
    const sessions = new Map([
      ['failed', { key, expiresAt: Date.now() + 60_000, state: 'failed' as const }],
    ]);
    expect(findReusableIosHlsSession(sessions, key)).toBeNull();
  });

  it('retains complete output but marks unsuccessful FFmpeg exits failed', () => {
    expect(iosHlsProcessExitState(0, null)).toBe('complete');
    expect(iosHlsProcessExitState(1, null)).toBe('failed');
    expect(iosHlsProcessExitState(null, 'SIGKILL')).toBe('failed');
  });
});

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

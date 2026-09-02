import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, createIosHlsTicket, sanitizeFfmpegMessage, verifyIosHlsTicket } from './ios-hls-security';

const claims = {
  channelId: 'vod_83608',
  sourceUrl: 'http://provider.example/movie.mkv',
  contentType: 'movies' as const,
  startSeconds: 0,
};

describe('iOS HLS signed tickets', () => {
  it('accepts the signed claims once before expiry and rejects tampering', () => {
    const ticket = createIosHlsTicket(claims, 'server-secret', 2_000, 'nonce-123');
    expect(verifyIosHlsTicket(ticket, claims, 'server-secret', 1_000)).toEqual({
      valid: true,
      nonce: 'nonce-123',
      expiresAt: 2_000,
    });
    expect(verifyIosHlsTicket(ticket, { ...claims, startSeconds: 10 }, 'server-secret', 1_000).valid).toBe(false);
    expect(verifyIosHlsTicket(ticket, claims, 'server-secret', 2_001).valid).toBe(false);
  });

  it('rate-limits repeated ticket creation per client', () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.allow('client', 0)).toBe(true);
    expect(limiter.allow('client', 1)).toBe(true);
    expect(limiter.allow('client', 2)).toBe(false);
    expect(limiter.allow('client', 1_001)).toBe(true);
  });

  it('rejects malformed JSON ticket bodies without throwing', () => {
    const malformed = `${Buffer.from('null').toString('base64url')}.invalid`;
    expect(() => verifyIosHlsTicket(malformed, claims, 'server-secret', 1_000)).not.toThrow();
    expect(verifyIosHlsTicket(malformed, claims, 'server-secret', 1_000).valid).toBe(false);
  });

  it('bounds stale distributed-client rate-limit state', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    for (let index = 0; index < 1_100; index++) limiter.allow(`client-${index}`, 0);
    limiter.allow('fresh-client', 1_001);
    expect(limiter.size).toBe(1);
  });

  it('redacts raw and encoded provider URLs from FFmpeg diagnostics', () => {
    const message = 'failed http://provider/movie/user/pass/1 url=http%3A%2F%2Fprovider%2Fmovie%2Fuser%2Fpass%2F1';
    const sanitized = sanitizeFfmpegMessage(message);
    expect(sanitized).not.toContain('user');
    expect(sanitized).not.toContain('pass');
  });
});

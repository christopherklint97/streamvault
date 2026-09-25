import { describe, expect, it } from 'vitest';
import {
  canAccessRecordingStream,
  createRecordingPlaybackTicket,
  isAuthorizedRequest,
  maskConfigResponse,
  normalizeAllowedOrigins,
  validateExternalHttpUrl,
  validateSourceHttpUrl,
  validateXtreamServerUrl,
} from './security';

describe('server security helpers', () => {
  it('masks secrets in config responses while preserving presence flags', () => {
    expect(maskConfigResponse({
      inputMode: 'xtream',
      playlistUrl: '',
      epgUrl: '',
      xtreamServer: 'https://provider.example',
      xtreamUsername: 'alice',
      xtreamPassword: 'secret',
      syncInterval: '24h',
      commercialAutoSkip: false,
    })).toEqual({
      inputMode: 'xtream',
      playlistUrl: '',
      epgUrl: '',
      xtreamServer: 'https://provider.example',
      xtreamUsername: 'alice',
      xtreamPassword: '',
      hasXtreamPassword: true,
      syncInterval: '24h',
      commercialAutoSkip: false,
    });
  });

  it('accepts requests when no auth token is configured', () => {
    expect(isAuthorizedRequest(undefined, undefined)).toBe(true);
  });

  it('requires bearer token or x-streamvault-token when configured', () => {
    expect(isAuthorizedRequest('Bearer expected', 'expected')).toBe(true);
    expect(isAuthorizedRequest('wrong', 'expected', 'expected')).toBe(true);
    expect(isAuthorizedRequest('Bearer wrong', 'expected')).toBe(false);
    expect(isAuthorizedRequest(undefined, 'expected')).toBe(false);
  });

  it('keeps recording streams public only when authentication is disabled', () => {
    expect(canAccessRecordingStream('r1', undefined, undefined, 1_000)).toBe(true);
    expect(canAccessRecordingStream('r1', 'secret', undefined, 1_000)).toBe(false);
  });

  it('defaults playback tickets to a full-program lifetime', () => {
    const issued = createRecordingPlaybackTicket('r1', 'secret', 1_000);
    expect(issued.expiresAt).toBe(1_000 + 12 * 60 * 60_000);
    expect(canAccessRecordingStream('r1', 'secret', issued.ticket, issued.expiresAt - 1)).toBe(true);
  });

  it('issues recording-bound HMAC playback tickets', () => {
    const issued = createRecordingPlaybackTicket('recording / 1', 'secret', 1_000, 60_000);
    expect(issued.expiresAt).toBe(61_000);
    expect(canAccessRecordingStream('recording / 1', 'secret', issued.ticket, 60_999)).toBe(true);
    expect(canAccessRecordingStream('other', 'secret', issued.ticket, 2_000)).toBe(false);
    expect(canAccessRecordingStream('recording / 1', 'wrong', issued.ticket, 2_000)).toBe(false);
    expect(canAccessRecordingStream('recording / 1', 'secret', `${issued.ticket}x`, 2_000)).toBe(false);
    expect(canAccessRecordingStream('recording / 1', 'secret', issued.ticket, 61_001)).toBe(false);
  });

  it('normalizes configured CORS origins', () => {
    expect(normalizeAllowedOrigins('https://a.example, http://b.example ')).toEqual(['https://a.example', 'http://b.example']);
    expect(normalizeAllowedOrigins('')).toEqual([]);
  });

  it('rejects non-http, localhost, private, and link-local URLs', () => {
    expect(validateExternalHttpUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateExternalHttpUrl('http://localhost:3000').ok).toBe(false);
    expect(validateExternalHttpUrl('http://127.0.0.1:3000').ok).toBe(false);
    expect(validateExternalHttpUrl('http://10.0.0.5/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://192.168.1.5/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://169.254.1.5/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[::1]/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[::ffff:127.0.0.1]/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[fe90::1]/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[fec0::1]/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[fc00::1]/video.ts').ok).toBe(false);
    expect(validateExternalHttpUrl('http://[ff02::1]/video.ts').ok).toBe(false);
  });

  it('accepts an explicitly configured RFC1918 Xtream server but never local services', () => {
    expect(validateXtreamServerUrl('http://192.168.1.5:9191').ok).toBe(true);
    expect(validateXtreamServerUrl('http://10.1.2.3:8080').ok).toBe(true);
    expect(validateXtreamServerUrl('http://172.31.2.3').ok).toBe(true);
    for (const host of ['127.0.0.1', '169.254.1.2', '0.0.0.0', '224.0.0.1', '[::1]', 'localhost']) {
      expect(validateXtreamServerUrl(`http://${host}:8080`).ok, host).toBe(false);
    }
  });

  it('permits only the exact saved LAN Xtream origin for media and redirects', () => {
    const source = 'http://192.168.1.5:9191';
    expect(validateSourceHttpUrl(`${source}/live/user/pass/1.ts`, source, ['192.168.1.5']).ok).toBe(true);
    for (const url of [
      'http://192.168.1.6:9191/live', 'http://192.168.1.5:9192/live',
      'https://192.168.1.5:9191/live', 'http://127.0.0.1:9191/live',
      'http://169.254.169.254/latest', 'file:///etc/passwd',
    ]) expect(validateSourceHttpUrl(url, source, ['192.168.1.5']).ok, url).toBe(false);
    expect(validateSourceHttpUrl(`${source}/live`, '', ['192.168.1.5']).ok).toBe(false);
    expect(validateSourceHttpUrl('https://cdn.example.com/movie', source, ['192.168.1.5', 'cdn.example.com']).ok).toBe(true);
  });

  it('allows external http urls and can restrict them to an allowlist', () => {
    expect(validateExternalHttpUrl('https://cdn.example.com/video.ts').ok).toBe(true);
    expect(validateExternalHttpUrl('https://cdn.example.com/video.ts', ['cdn.example.com']).ok).toBe(true);
    expect(validateExternalHttpUrl('https://evil.example/video.ts', ['cdn.example.com']).ok).toBe(false);
  });
});

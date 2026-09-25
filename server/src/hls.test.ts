import { describe, expect, it } from 'vitest';
import { authorizeHlsProxyUrl, rewriteHlsManifest, signHlsProxyUrl, verifyHlsProxyTicket } from './hls';

describe('rewriteHlsManifest', () => {
  it('rewrites relative and absolute segment lines through the proxy', () => {
    const manifest = ['#EXTM3U', '#EXTINF:10,', 'seg-1.ts', '#EXTINF:10,', 'https://cdn.example.com/seg-2.ts'].join('\n');
    const rewritten = rewriteHlsManifest(manifest, 'https://origin.example/live/playlist.m3u8');
    expect(rewritten).toContain('/api/proxy?url=https%3A%2F%2Forigin.example%2Flive%2Fseg-1.ts');
    expect(rewritten).toContain('/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fseg-2.ts');
  });

  it('rewrites URI attributes for encryption keys and init maps', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
      '#EXT-X-MAP:URI="init.mp4"',
      'chunk.ts',
    ].join('\n');
    const rewritten = rewriteHlsManifest(manifest, 'https://origin.example/live/master.m3u8');
    expect(rewritten).toContain('URI="/api/proxy?url=https%3A%2F%2Forigin.example%2Flive%2Fkeys%2Fkey.bin"');
    expect(rewritten).toContain('URI="/api/proxy?url=https%3A%2F%2Forigin.example%2Flive%2Finit.mp4"');
  });
  it('signs rewritten CDN segments but does not authorize forged URLs', () => {
    const secret = Buffer.alloc(32, 7);
    const url = 'https://cdn.example.com/part.ts';
    const manifest = rewriteHlsManifest('#EXTM3U\npart.ts', 'https://cdn.example.com/live/index.m3u8',
      source => signHlsProxyUrl(source, secret, 1_000));
    const proxy = new URL(manifest.split('\n')[1], 'http://localhost');
    const ticket = proxy.searchParams.get('ticket') || '';
    expect(proxy.searchParams.get('url')).toBe('https://cdn.example.com/live/part.ts');
    expect(verifyHlsProxyTicket(proxy.searchParams.get('url') || '', ticket, secret, 1_001)).toBe(true);
    expect(verifyHlsProxyTicket(url, ticket, secret, 1_001)).toBe(false);
    expect(verifyHlsProxyTicket(proxy.searchParams.get('url') || '', ticket, secret, 1_000 + 12 * 60 * 60_000 + 1)).toBe(false);
    expect(verifyHlsProxyTicket(proxy.searchParams.get('url') || '', `${ticket}x`, secret, 1_001)).toBe(false);
  });
  it('authorizes only signed out-of-list public CDN segments', () => {
    const secret = Buffer.alloc(32, 8);
    const source = 'http://192.168.1.5:9191';
    const allowed = ['192.168.1.5'];
    const cdn = 'https://cdn.example.com/part.ts';
    const ticket = new URL(signHlsProxyUrl(cdn, secret), 'http://localhost').searchParams.get('ticket') || '';
    expect(authorizeHlsProxyUrl(cdn, undefined, secret, source, allowed).ok).toBe(false);
    expect(authorizeHlsProxyUrl(cdn, ticket, secret, source, allowed).ok).toBe(true);
    expect(authorizeHlsProxyUrl('https://other.example/part.ts', ticket, secret, source, allowed).ok).toBe(false);
    const privateUrl = 'http://127.0.0.1/private';
    const privateTicket = new URL(signHlsProxyUrl(privateUrl, secret), 'http://localhost').searchParams.get('ticket') || '';
    expect(authorizeHlsProxyUrl(privateUrl, privateTicket, secret, source, allowed).ok).toBe(false);
  });
});

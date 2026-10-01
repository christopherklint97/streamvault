import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { fetchWithRedirects, requestStream, safeProxyChannelId, safeProxyMime, safeProxyLength,
  safeProxyContentRange, safeProxyAcceptRanges, safeRequestLogPath, isUpstreamHtmlResponse,
  isLoopbackCaptureSession } from './stream-utils';

let server: Server;
let origin: string;
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/private' }).end();
    } else res.writeHead(200).end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('proxy log hygiene', () => {
  it('allows only stable channel IDs and canonical media metadata, never arbitrary URL-bearing fields', () => {
    expect(safeProxyChannelId('live_44115')).toBe('live_44115');
    expect(safeProxyChannelId('live_44115/secret')).toBe('unknown');
    expect(safeProxyMime('video/mp2t')).toBe('video/mp2t');
    expect(safeProxyMime('video/mp2t; url=https://host/private')).toBe('other');
    expect(safeProxyLength('1024')).toBe('1024');
    expect(safeProxyLength('1024; token=hidden')).toBe('unknown');
    expect(safeProxyContentRange('bytes 0-188/189')).toBe('bytes 0-188/189');
    expect(safeProxyContentRange('bytes 0-188/189;token=hidden')).toBeNull();
    expect(safeProxyAcceptRanges('bytes')).toBe('bytes');
    expect(safeProxyAcceptRanges('token=hidden')).toBeNull();
    expect(safeRequestLogPath('/api/stream/live_44115')).toBe('/api/stream/:channelId');
    expect(safeRequestLogPath('/api/stream/token%3Dhidden')).toBe('/api/stream/:channelId');
    expect(safeRequestLogPath('/API/STREAM/token%3Dhidden')).toBe('/api/stream/:channelId');
    expect(safeRequestLogPath('/%41PI/STREAM/token%3Dhidden')).toBe('/:path');
    expect(safeRequestLogPath('/api/other/token%3Dhidden')).toBe('/api/:route');
    expect(safeRequestLogPath('/token%3Dhidden')).toBe('/:path');
    expect(isUpstreamHtmlResponse('TEXT/HTML; charset=UTF-8')).toBe(true);
    expect(isUpstreamHtmlResponse('application/xhtml+xml')).toBe(true);
    expect(isUpstreamHtmlResponse('video/mp2t')).toBe(false);
    expect(safeProxyMime('TEXT/HTML; charset=UTF-8')).toBe('other');
    expect(safeProxyMime('application/javascript')).toBe('other');
    expect(safeProxyMime('application/vnd.apple.mpegurl; charset=UTF-8')).toBe('application/vnd.apple.mpegurl');
    expect(safeRequestLogPath('/api/health')).toBe('/api/health');
  });
  it('accepts only loopback requests with a well-formed capture session tag', () => {
    const session = '11111111-1111-4111-8111-111111111111';
    expect(isLoopbackCaptureSession('127.0.0.1', session)).toBe(session);
    expect(isLoopbackCaptureSession('::ffff:127.0.0.1', session)).toBe(session);
    expect(isLoopbackCaptureSession('::1', session)).toBe(session);
    expect(isLoopbackCaptureSession('192.0.2.4', session)).toBeNull();
    expect(isLoopbackCaptureSession('127.0.0.1', 'bad;token=hidden')).toBeNull();
  });
  it('masks routed and unmatched encoded paths before request logging', async () => {
    const app = express();
    const labels: string[] = [];
    app.use((req, _res, next) => { labels.push(safeRequestLogPath(req.path)); next(); });
    app.get('/api/stream/:channelId', (_req, res) => res.end('ok'));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      expect((await fetch(`${base}/API/STREAM/token%3Dhidden`)).status).toBe(200);
      expect((await fetch(`${base}/%41PI/STREAM/token%3Dhidden`)).status).toBe(404);
      expect(labels).toEqual(['/api/stream/:channelId', '/:path']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('stream redirects', () => {
  it('rejects a disallowed redirect before requesting its target', async () => {
    const before = hits;
    await expect(requestStream(`${origin}/redirect`, {}, 3, 2_000, url => new URL(url).origin === origin)).rejects.toThrow('Redirect target is not allowed');
    expect(hits - before).toBe(1);
  });
  it('blocks a disallowed redirect when resolving media with fetch', async () => {
    const before = hits;
    await expect(fetchWithRedirects(`${origin}/redirect`, {}, 3, 2_000, url => new URL(url).origin === origin)).rejects.toThrow('Redirect target is not allowed');
    expect(hits - before).toBe(1);
  });
});

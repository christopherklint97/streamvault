import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchWithRedirects, requestStream, safeProxyChannelId, safeProxyMime, safeProxyLength } from './stream-utils';

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

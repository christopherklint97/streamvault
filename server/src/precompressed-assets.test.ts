// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { brotliCompressSync, gunzipSync, gzipSync, brotliDecompressSync } from 'node:zlib';
import { servePrecompressedAssets } from './precompressed-assets.js';

const source = Buffer.from('console.log("StreamVault static fixture");\n'.repeat(100));
let dir: string;
let server: http.Server;
let base: string;
function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request(base + url, { headers, method, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('static fixture request timed out')));
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-static-'));
  for (const ext of ['js', 'css']) {
    const file = path.join(dir, 'main.' + ext);
    fs.writeFileSync(file, source);
    fs.writeFileSync(file + '.gz', gzipSync(source));
    fs.writeFileSync(file + '.br', brotliCompressSync(source));
  }
  fs.writeFileSync(path.join(dir, 'raw.js'), source);
  fs.writeFileSync(path.join(dir, 'gzip.js'), source);
  fs.writeFileSync(path.join(dir, 'gzip.js.gz'), gzipSync(source));
  const app = express();
  app.use('/assets', servePrecompressedAssets(dir));
  app.use('/assets', express.static(dir));
  app.get('/api/media.ts', (_req, res) => res.type('video/mp2t').send(source));
  app.use((_req, res) => res.status(404).end());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('precompressed static assets', () => {
  it('negotiates Brotli and preserves JS MIME, decoded bytes and immutable cache policy', async () => {
    const r = await request('/assets/main.js', { 'Accept-Encoding': 'br, gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers.vary).toContain('Accept-Encoding');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(brotliDecompressSync(r.body)).toEqual(source);
    expect(r.body.length).toBeLessThan(source.length);
  });
  it('respects gzip quality preference and retains the original CSS MIME', async () => {
    const r = await request('/assets/main.css', { 'Accept-Encoding': 'br;q=0.2, gzip;q=1' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['content-type']).toMatch(/text\/css/);
    expect(gunzipSync(r.body)).toEqual(source);
  });
  it('uses an available compressed fallback when Brotli is missing', async () => {
    const r = await request('/assets/gzip.js', { 'Accept-Encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(r.body)).toEqual(source);
  });
  it('keeps identity available when compression is rejected or missing', async () => {
    for (const [file, accept] of [['main.js', 'br;q=0, gzip;q=0'], ['raw.js', 'br, gzip'], ['main.js', 'identity'], ['main.js', '']]) {
      const r = await request('/assets/' + file, { 'Accept-Encoding': accept });
      expect(r.status).toBe(200);
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers.vary).toContain('Accept-Encoding');
      expect(r.body).toEqual(source);
    }
  });
  it('returns 406 when all available representations are explicitly forbidden', async () => {
    const r = await request('/assets/main.js', { 'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0' });
    expect(r.status).toBe(406);
  });
  it('handles HEAD and conditional requests for the selected representation', async () => {
    const r = await request('/assets/main.js', { 'Accept-Encoding': 'br' });
    const head = await request('/assets/main.js', { 'Accept-Encoding': 'br' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-encoding']).toBe('br');
    expect(Number(head.headers['content-length'])).toBe(r.body.length);
    expect(head.body.length).toBe(0);
    const cached = await request('/assets/main.js', { 'Accept-Encoding': 'br', 'If-None-Match': r.headers.etag! });
    expect(cached.status).toBe(304);
    expect(cached.headers.vary).toContain('Accept-Encoding');
  });
  it('preserves identity byte ranges rather than ranging compressed bytes', async () => {
    for (const accept of ['br, gzip', 'identity', '', '*;q=0, identity;q=1']) {
      const r = await request('/assets/main.js', { 'Accept-Encoding': accept, Range: 'bytes=0-9' });
      expect(r.status).toBe(206);
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers['content-range']).toBe(`bytes 0-9/${source.length}`);
      expect(r.headers.vary).toContain('Accept-Encoding');
      expect(r.body).toEqual(source.subarray(0, 10));
    }
    const absent = await request('/assets/main.js', { Range: 'bytes=0-9' });
    expect(absent.status).toBe(206);
    expect(absent.headers['content-encoding']).toBeUndefined();
    expect(absent.body).toEqual(source.subarray(0, 10));
  });
  it.each([
    ['main.js', 'identity;q=0, br', 'GET'],
    ['main.js', '*;q=0', 'GET'],
    ['main.css', 'identity;q=0, br', 'GET'],
    ['raw.js', '*;q=0', 'GET'],
    ['main.js', 'identity;q=0, br', 'HEAD'],
    ['main.js', '*;q=0', 'HEAD'],
  ])('rejects identity-forbidden static ranges: %s, %s, %s', async (file, accept, method) => {
    const r = await request('/assets/' + file, { 'Accept-Encoding': accept, Range: 'bytes=0-9' }, method);
    expect(r.status).toBe(406);
    expect(r.headers.vary).toContain('Accept-Encoding');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['content-range']).toBeUndefined();
    expect(r.body.length).toBe(0);
  });
  it('does not compress media routes or substitute HTML for missing chunks', async () => {
    const media = await request('/api/media.ts', { 'Accept-Encoding': 'br, gzip' });
    expect(media.headers['content-encoding']).toBeUndefined();
    expect(media.body).toEqual(source);
    for (const accept of ['identity;q=0, br', '*;q=0']) {
      const media = await request('/api/media.ts', { 'Accept-Encoding': accept, Range: 'bytes=0-9' });
      expect(media.status).toBe(200);
      expect(media.headers['content-encoding']).toBeUndefined();
      expect(media.headers.vary).toBeUndefined();
      expect(media.body).toEqual(source);
    }
    const missing = await request('/assets/missing.js', { 'Accept-Encoding': 'br, gzip' });
    expect(missing.status).toBe(404);
    expect(missing.headers['content-encoding']).toBeUndefined();
  });
  it('does not escape the asset root through encoded traversal', async () => {
    const r = await request('/assets/%2e%2e%2foutside.js', { 'Accept-Encoding': 'br' });
    expect(r.status).toBe(404);
  });
});

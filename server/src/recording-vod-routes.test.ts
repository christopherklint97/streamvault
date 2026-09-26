// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasActiveRecordingVodViewer, registerRecordingVodRoutes } from './recording-vod-routes.js';
import { vodHlsDirectory } from './recording-vod-hls';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(ready: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-vod-route-')); roots.push(root);
  const master = path.join(root, 'r1.ts'); fs.writeFileSync(master, 'master');
  if (ready) {
    const dir = vodHlsDirectory(master); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'segment-00000.ts'), 'segment');
    fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
    const stat = fs.statSync(master);
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, durationSeconds: 4 }));
  }
  return master;
}

async function serve(master: string, ensure = vi.fn(async () => {})): Promise<{ base: string; ensure: typeof ensure }> {
  const app = express();
  registerRecordingVodRoutes(app, {
    getMasterPath: id => id === 'r1' ? master : null,
    getStatus: id => id === 'r1' ? 'completed' : null,
    getDuration: id => id === 'r1' ? 4 : 0,
    canAccess: (_id, ticket) => ticket === 'valid',
    requireAuth: (_req, _res, next) => next(),
    ensure,
    isPreparing: () => false,
  });
  app.get('/api/recordings/:id/hls/index.m3u8', (_req, res) => res.type('application/vnd.apple.mpegurl').send('rolling'));
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server port');
  return { base: `http://127.0.0.1:${address.port}`, ensure };
}

describe('recording VOD HTTP routes', () => {
  it('returns a finite playlist and seekable segments behind one opaque session', async () => {
    const { base } = await serve(fixture(true));
    const start = await fetch(`${base}/api/recordings/r1/hls/index.m3u8?ticket=valid`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = start.headers.get('location')!;
    expect(location).toMatch(/^\/api\/recordings\/r1\/vod\/index\.m3u8\?session=/);
    expect(hasActiveRecordingVodViewer('r1')).toBe(true);
    expect(hasActiveRecordingVodViewer('other')).toBe(false);
    const playlist = await fetch(`${base}${location}`);
    const text = await playlist.text();
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    const segment = text.match(/\/api\/recordings\/r1\/vod\/segment-\d+\.ts\?session=[^\s]+/)?.[0];
    expect(segment).toBeTruthy();
    const media = await fetch(`${base}${segment}`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toMatch(/video\/mp2t/);
    expect(await media.text()).toBe('segment');
    const resumed = await fetch(`${base}/api/recordings/r1/hls/index.m3u8?ticket=valid&start=30`);
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toBe('rolling');
    expect((await fetch(`${base}/api/recordings/r1/vod/index.m3u8?session=invalid`)).status).toBe(404);
  });

  it('starts a background build but retains immediate rolling playback until the VOD package is ready', async () => {
    const master = fixture(false);
    const { base, ensure } = await serve(master);
    const response = await fetch(`${base}/api/recordings/r1/hls/index.m3u8?ticket=valid`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rolling');
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith(master, 4));
    const resumed = await fetch(`${base}/api/recordings/r1/hls/index.m3u8?ticket=valid&start=21`);
    expect(await resumed.text()).toBe('rolling');
    expect(ensure).toHaveBeenCalledWith(master, 4);
    expect((await (await fetch(`${base}/api/recordings/r1/vod-status`)).json()).status).toBe('missing');
  });
});

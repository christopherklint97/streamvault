import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createLiveBuffer, createLiveRouter, newStageIndices } from './live-buffer.js';

it('rejects missing FFmpeg stage segments and ignores already-published windows', () => {
  expect(newStageIndices([0, 1, 2], -1)).toEqual([0, 1, 2]);
  expect(newStageIndices([1, 2, 3], 2)).toEqual([3]);
  expect(newStageIndices([5, 6], 2)).toBeNull();
  expect(newStageIndices([1, 3], 0)).toBeNull();
});

const servers: Server[] = [];
const roots: string[] = [];
const buffers: ReturnType<typeof createLiveBuffer>[] = [];
afterEach(async () => {
  for (const buffer of buffers.splice(0)) await buffer.stop();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.STREAMVAULT_AUTH_TOKEN;
});
async function listen(app: ReturnType<typeof express>): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('No port');
  return `http://127.0.0.1:${addr.port}`;
}
async function fixture(): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), 'sv-live-fixture-'));
  roots.push(root);
  const output = path.join(root, 'source.ts');
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'aac', '-f', 'mpegts', output], { timeout: 15000 });
  if (result.status !== 0) throw Error('Fixture encoder failed');
  return readFile(output);
}
async function subtitledFixture(): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), 'sv-live-subs-'));
  roots.push(root);
  const srt = path.join(root, 'subs.srt');
  const output = path.join(root, 'source.mkv');
  await writeFile(srt, '1\n00:00:00,000 --> 00:00:03,000\nHello from live TV.\n');
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'aac', '-c:s', 'webvtt', output], { timeout: 15000 });
  if (result.status !== 0) throw Error('Subtitled fixture failed');
  return readFile(output);
}
async function mockSource(body: Buffer, framing: 'chunked' | 'length' | 'silent') {
  const app = express();
  let requests = 0;
  app.get('/source', (_req, res) => {
    requests++;
    res.type('video/mp2t');
    if (framing === 'length') res.setHeader('Content-Length', body.length);
    if (framing === 'silent') { res.write(body.subarray(0, 188)); return; }
    if (framing === 'chunked') {
      for (let pos = 0; pos < body.length; pos += 1324) res.write(body.subarray(pos, pos + 1324));
      res.end();
    } else res.end(body);
  });
  return { url: `${await listen(app)}/source`, requests: () => requests };
}
async function harness(url: string, opts: { stallMs?: number; idleMs?: number; maxChannels?: number; maxReaders?: number; maxBytesPerChannel?: number; maxSegmentBytes?: number; minFreeBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sv-live-buffer-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, pollMs: 100, retryMs: 200, maxBytesPerChannel: 8 * 1024 * 1024, maxSegmentBytes: 2 * 1024 * 1024, ...opts });
  buffers.push(buffer);
  const app = express();
  app.use('/api/live', createLiveRouter(buffer, (id) => id === 'channel-a' || id === 'channel-b' ? url : null));
  const base = await listen(app);
  return { root, buffer, base, playlist: `${base}/api/live/channel-a/index.m3u8` };
}
async function waitPlaylist(url: string, predicate: (text: string) => boolean, timeout = 9000): Promise<string> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const response = await fetch(url);
    if (response.status === 200) {
      const body = await response.text();
      if (predicate(body)) return body;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Playlist did not reach expected state');
}

describe('shared live rolling HLS HTTP', () => {
  it.each(['chunked', 'length'] as const)('reopens %s EOF, preserves session boundary and shares ingestion', async framing => {
    const source = await mockSource(await fixture(), framing);
    const { playlist, base } = await harness(source.url);
    const startedAt = performance.now();
    const [a, b] = await Promise.all([fetch(playlist), fetch(playlist)]);
    expect(a.status).toBe(503); expect(b.status).toBe(503);
    await waitPlaylist(playlist, text => text.includes('segment/'));
    const firstPlayableMs = Math.round(performance.now() - startedAt);
    console.info(`live HLS ${framing} first playable segment: ${firstPlayableMs} ms`);
    expect(firstPlayableMs).toBeLessThan(9000);
    const manifest = await waitPlaylist(playlist, text => text.includes('#EXT-X-DISCONTINUITY') && (text.match(/segment\//g) || []).length >= 2);
    expect(manifest).not.toContain('#EXT-X-ENDLIST');
    expect(manifest).toContain('#EXT-X-TARGETDURATION:4');
    const paths = [...manifest.matchAll(/^(segment\/[^\s]+)$/gm)].map(match => match[1]);
    expect(paths.length).toBeGreaterThan(1);
    const segment = await fetch(new URL(paths[0], playlist));
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toContain('video/mp2t');
    expect(segment.headers.get('cache-control')).toContain('no-store');
    expect(segment.headers.get('x-content-type-options')).toBe('nosniff');
    const segmentBytes = Buffer.from(await segment.arrayBuffer());
    expect(segmentBytes.byteLength).toBeGreaterThan(0);
    const probeRoot = await mkdtemp(path.join(tmpdir(), 'sv-live-probe-'));
    roots.push(probeRoot);
    const probeFile = path.join(probeRoot, 'published.ts');
    await writeFile(probeFile, segmentBytes);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', probeFile], { timeout: 5000 });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout.toString()).streams.map((stream: { codec_type: string }) => stream.codec_type)).toEqual(expect.arrayContaining(['video', 'audio']));
    await waitPlaylist(playlist, text => text.includes('#EXT-X-DISCONTINUITY') && source.requests() > 1);
    const other = await fetch(`${base}/api/live/channel-b/index.m3u8`);
    expect([200, 503]).toContain(other.status);
  }, 20000);

  it('rejects unknown channels and audio-only mode rather than serving full A/V', async () => {
    const { playlist, base } = await harness('http://127.0.0.1:1/unreachable');
    expect((await fetch(`${base}/api/live/missing/index.m3u8`)).status).toBe(404);
    const audio = await fetch(`${playlist}?audio=1`);
    expect(audio.status).toBe(422);
    expect((await fetch(`${base}/api/live/channel-a/segment/123.ts?audio=1`)).status).toBe(422);
  });

  it('does not authorize a native player while no playable segment exists', async () => {
    const { base, buffer } = await harness('http://127.0.0.1:1/unreachable');
    const response = await fetch(`${base}/api/live/channel-a/authorize`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(buffer.activeCount).toBe(1);
  }, 10000);

  it('authenticates the playlist and segments with a bounded native-playback ticket', async () => {
    process.env.STREAMVAULT_AUTH_TOKEN = 'synthetic-token';
    const source = await mockSource(await fixture(), 'length');
    const { playlist, base } = await harness(source.url);
    expect((await fetch(playlist)).status).toBe(401);
    const ticketResponse = await fetch(`${base}/api/live/channel-a/authorize`, { headers: { authorization: 'Bearer synthetic-token' } });
    expect(ticketResponse.status).toBe(200);
    const { playlistUrl, expiresAt } = await ticketResponse.json();
    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(playlistUrl).toMatch(/^\/api\/live\/channel-a\/index\.m3u8\?ticket=/);
    const manifest = await waitPlaylist(new URL(playlistUrl, base).toString(), text => text.includes('segment/'));
    const segmentPath = manifest.split('\n').find(line => line.startsWith('segment/'))!;
    expect(segmentPath).toMatch(/[?&]ticket=/);
    expect((await fetch(new URL(segmentPath.split('?')[0], playlist))).status).toBe(401);
    expect((await fetch(new URL(segmentPath.replace(/ticket=[^&]+/, 'ticket=invalid'), playlist))).status).toBe(401);
    expect((await fetch(new URL(segmentPath, new URL(playlistUrl, base)))).status).toBe(200);
    const expired = `${Date.now() - 1000}.${'a'.repeat(43)}`;
    expect((await fetch(`${playlist}?ticket=${expired}`)).status).toBe(401);
    expect((await fetch(`${base}/api/live/channel-b/index.m3u8?ticket=${new URL(playlistUrl, base).searchParams.get('ticket')}`)).status).toBe(401);
    expect((await fetch(`${base}/api/live/channel-a/authorize`)).status).toBe(401);
    expect((await fetch(`${base}/api/live/channel-a/authorize?ticket=${new URL(playlistUrl, base).searchParams.get('ticket')}`)).status).toBe(401);
  }, 20000);

  it('kills silent sources, backs off, limits workers, expires idle workers, and removes temporary files', async () => {
    const source = await mockSource(await fixture(), 'silent');
    const { buffer, playlist, base, root } = await harness(source.url, { stallMs: 600, idleMs: 2200, maxChannels: 1 });
    await fetch(playlist);
    expect((await fetch(`${base}/api/live/channel-b/index.m3u8`)).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 1900));
    expect(source.requests()).toBeGreaterThanOrEqual(2);
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(buffer.activeCount).toBe(0);
    await expect((await import('node:fs/promises')).readdir(root).then(entries => entries.length)).resolves.toBe(0);
  }, 12000);

  it('bounds rolling files and rejects evicted segments while serving current ones', async () => {
    const source = await mockSource(await fixture(), 'length');
    const { root, playlist, base, buffer } = await harness(source.url, { maxBytesPerChannel: 400_000, maxSegmentBytes: 200_000 });
    await fetch(playlist);
    const initial = await waitPlaylist(playlist, text => text.includes('segment/'));
    const initialSequence = Number(initial.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);
    expect(initialSequence).toBeLessThan(2 ** 31);
    const latest = await waitPlaylist(playlist, text => Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0) > initialSequence + 2);
    expect(latest).not.toContain('#EXT-X-ENDLIST');
    expect((await fetch(`${base}/api/live/channel-a/segment/${initialSequence}.ts`)).status).toBe(404);
    const activePath = latest.split('\n').find(line => line.startsWith('segment/'))!;
    expect((await fetch(new URL(activePath, playlist))).status).toBe(200);
    const folders = await (await import('node:fs/promises')).readdir(root);
    expect(folders).toHaveLength(1);
    const files = await (await import('node:fs/promises')).readdir(path.join(root, folders[0]), { recursive: true });
    expect(files.length).toBeLessThan(16);
    await buffer.stop();
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toHaveLength(0);
  }, 20000);

  it('clears orphaned ingest directories before starting and caps tiny-segment count', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sv-live-recovery-'));
    roots.push(root);
    const orphan = path.join(root, 'channel-orphan');
    await (await import('node:fs/promises')).mkdir(orphan);
    await writeFile(path.join(orphan, 'orphan.ts'), 'stale');
    const source = await mockSource(await fixture(), 'length');
    const buffer = createLiveBuffer({ root, pollMs: 50, retryMs: 100, maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000 });
    buffers.push(buffer);
    await buffer.playlist('channel-a', source.url);
    await expect((await import('node:fs/promises')).stat(orphan)).rejects.toThrow();
    let initialSequence: number | undefined;
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      const manifest = await buffer.playlist('channel-a', source.url);
      if (manifest && initialSequence === undefined) initialSequence = Number(manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);
      if (manifest && initialSequence !== undefined && Number(manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]) > initialSequence + 16) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const manifest = await buffer.playlist('channel-a', source.url);
    expect(Number(manifest?.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1])).toBeGreaterThan(initialSequence! + 16);
    expect((manifest?.match(/^segment\//gm) ?? []).length).toBeLessThanOrEqual(12);
  }, 16000);

  it('does not silently strip real subtitle streams when buffering cannot serve their rendition', async () => {
    const source = await mockSource(await subtitledFixture(), 'length');
    const { base, buffer } = await harness(source.url);
    const response = await fetch(`${base}/api/live/channel-a/authorize`);
    expect(response.status).toBe(503);
    expect(source.requests()).toBeGreaterThan(0);
    expect(await buffer.playlist('channel-a', source.url)).toBeNull();
  }, 12000);

  it('bounds simultaneous authorization waiters instead of polling for every viewer', async () => {
    const source = await mockSource(await fixture(), 'silent');
    const { base } = await harness(source.url, { stallMs: 600 });
    const endpoint = `${base}/api/live/channel-a/authorize`;
    const pending = Array.from({ length: 8 }, () => fetch(endpoint));
    await new Promise(resolve => setTimeout(resolve, 250));
    const started = Date.now();
    const overloaded = await fetch(endpoint);
    expect(overloaded.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
    const responses = await Promise.all(pending);
    expect(responses.every(response => response.status === 503)).toBe(true);
  }, 12000);

  it('streams segments with a bounded number of open readers instead of buffering per viewer', async () => {
    const source = await mockSource(await fixture(), 'length');
    const { buffer, playlist } = await harness(source.url, { maxReaders: 1 });
    await fetch(playlist);
    const manifest = await waitPlaylist(playlist, text => text.includes('segment/'));
    const segmentPath = manifest.split('\n').find(line => line.startsWith('segment/'))!;
    const url = new URL(segmentPath, playlist);
    const id = Number(url.pathname.match(/\/(\d+)\.ts$/)?.[1]);
    const epoch = url.searchParams.get('epoch')!;
    const first = await buffer.segment('channel-a', id, epoch);
    if (!first || first === 'busy') throw Error('First segment did not open');
    expect(buffer.activeReaders).toBe(1);
    expect(await buffer.segment('channel-a', id, epoch)).toBe('busy');
    first.destroy();
    await new Promise(resolve => first.once('close', resolve));
    expect(buffer.activeReaders).toBe(0);
  }, 12000);

  it('never reuses a segment URL after an idle worker is retired', async () => {
    const source = await mockSource(await fixture(), 'length');
    const { playlist, buffer } = await harness(source.url, { idleMs: 500 });
    await fetch(playlist);
    const initial = await waitPlaylist(playlist, text => text.includes('segment/'));
    const oldPath = initial.split('\n').find(line => line.startsWith('segment/'))!;
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(buffer.activeCount).toBe(0);
    await fetch(playlist);
    const next = await waitPlaylist(playlist, text => text.includes('segment/'));
    const newPath = next.split('\n').find(line => line.startsWith('segment/'))!;
    expect(newPath).not.toBe(oldPath);
    expect((await fetch(new URL(newPath, playlist))).status).toBe(200);
    expect((await fetch(new URL(newPath.split('?')[0], playlist))).status).toBe(404);
    expect((await fetch(new URL(oldPath, playlist))).status).toBe(404);
  }, 16000);

  it('refuses ingest before spawning when the storage reserve cannot be met', async () => {
    const source = await mockSource(Buffer.alloc(188), 'silent');
    const { playlist, buffer, root } = await harness(source.url, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect((await fetch(playlist)).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(source.requests()).toBe(0);
    expect(buffer.activeCount).toBe(0);
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toHaveLength(0);
  });

  it('kills an ingest whose unfinished staging file grows past its cap', async () => {
    const source = await mockSource(Buffer.alloc(188), 'silent');
    const { playlist, root, buffer } = await harness(source.url);
    await fetch(playlist);
    const until = Date.now() + 5000;
    let ingest: string | undefined;
    while (Date.now() < until && !ingest) {
      const [channel] = await (await import('node:fs/promises')).readdir(root);
      if (channel) {
        const [name] = await (await import('node:fs/promises')).readdir(path.join(root, channel));
        if (name?.startsWith('ingest-')) ingest = path.join(root, channel, name);
      }
      if (!ingest) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(ingest).toBeDefined();
    await writeFile(path.join(ingest!, 'oversized.ts'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(buffer.activeCount).toBe(0);
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toHaveLength(0);
  }, 8000);
});

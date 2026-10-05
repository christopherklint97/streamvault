import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveBuffer, createLiveRouter, packetAwareLiveEnabled } from './live-buffer.js';

it('selects packet ingestion only with an explicit opt-in value', () => {
  expect(packetAwareLiveEnabled(undefined)).toBe(false);
  expect(packetAwareLiveEnabled('')).toBe(false);
  expect(packetAwareLiveEnabled('true')).toBe(false);
  expect(packetAwareLiveEnabled('1')).toBe(true);
});

const repo = path.resolve(import.meta.dirname, '../..');
const roots: string[] = [];
const servers: Server[] = [];
const buffers: ReturnType<typeof createLiveBuffer>[] = [];
afterEach(async () => {
  await Promise.all(buffers.splice(0).map(buffer => buffer.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  delete process.env.STREAMVAULT_AUTH_TOKEN;
});
async function listen(app: ReturnType<typeof express>) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  return `http://127.0.0.1:${address.port}`;
}
async function media() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sv-packet-media-'));
  roots.push(dir);
  const make = spawnSync('/usr/bin/python3', ['-c',
    'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from test_media import make_synthetic; make_synthetic(Path(sys.argv[2]))',
    path.join(repo, 'prototypes/live_packet_continuity'), dir], { timeout: 90000 });
  if (make.status !== 0) throw Error('synthetic fixture failed');
  return [await readFile(path.join(dir, 'first.ts')), await readFile(path.join(dir, 'second.ts'))];
}
async function waitFor<T>(fn: () => Promise<T | null>, ms = 12000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('packet live readiness deadline exceeded');
}

it('does not kill a progressing replay merely because HLS cannot publish duplicates yet', async () => {
  const [first, second] = await media();
  const upstream = express();
  let requests = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  upstream.get('/api/stream/channel-a', async (_req, res) => {
    requests++;
    res.type('video/mp2t');
    if (requests === 1) { res.set('Content-Length', String(first.length)); res.end(first); return; }
    if (requests === 2) {
      await waiting;
      for (let pos = 0; pos < second.length; pos += 8192) {
        if (res.destroyed) return;
        res.write(second.subarray(pos, pos + 8192));
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      res.end();
      return;
    }
    res.write(second.subarray(0, 188));
  });
  const proxy = await listen(upstream);
  const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-replay-progress-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, stallMs: 5000,
    maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000 });
  buffers.push(buffer);
  const url = `${proxy}/api/stream/channel-a`;
  await buffer.playlist('channel-a', url);
  try {
    await waitFor(async () => requests >= 2 ? true : null, 15000).catch(() => {
      throw Error(`first response did not reopen: requests=${requests} active=${buffer.activeCount}`);
    });
    release();
    await waitFor(async () => requests >= 3 ? true : null, 25000);
    expect(buffer.activeCount).toBe(1);
  } finally { release(); }
}, 60000);

it('retires a stale HLS timeline even when source keeps sending TS null packets', async () => {
  const [first] = await media();
  const nullPacket = Buffer.alloc(188, 0xff);
  nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
  const nullTransport = Buffer.concat(Array.from({ length: 100 }, () => nullPacket));
  const upstream = express();
  let requests = 0;
  upstream.get('/api/stream/channel-a', (_req, res) => {
    requests++;
    res.type('video/mp2t');
    res.write(first);
    const pace = setInterval(() => {
      if (res.destroyed) { clearInterval(pace); return; }
      res.write(nullTransport);
    }, 200);
    res.once('close', () => clearInterval(pace));
  });
  const proxy = await listen(upstream);
  const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-dead-timeline-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, stallMs: 1000,
    maxUnpublishedMs: 4500, maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000 });
  buffers.push(buffer);
  const url = `${proxy}/api/stream/channel-a`;
  await waitFor(async () => (await buffer.playlist('channel-a', url))?.includes('segment/') ? true : null);
  await waitFor(async () => buffer.activeCount === 0 ? true : null, 10000);
  expect(requests).toBe(1);
  expect(await buffer.playlist('channel-a', url)).toBeNull();
}, 20000);

it('reopens a stalled but complete chunked session and keeps the same decoder timeline', async () => {
  const [first, second] = await media();
  const upstream = express();
  let requests = 0;
  upstream.get('/api/stream/channel-a', (_req, res) => {
    requests++;
    res.type('video/mp2t');
    if (requests === 1) { res.write(first); return; } // no terminating chunk
    if (requests === 2) { res.set('Content-Length', String(second.length)); res.end(second); return; }
    res.write(second.subarray(0, 188));
  });
  const proxy = await listen(upstream);
  const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-stall-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, stallMs: 12000,
    maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000 });
  buffers.push(buffer);
  const url = `${proxy}/api/stream/channel-a`;
  await waitFor(async () => {
    const manifest = await buffer.playlist('channel-a', url);
    return requests >= 2 && manifest?.includes('segment/') ? manifest : null;
  }, 15000);
  expect(buffer.activeCount).toBe(1);
}, 25000);

const captured = '/home/christopherklint/.hermes/cache/scratch/live-eof-samples';
it.skipIf(!existsSync(path.join(captured, 'first.ts')) || !existsSync(path.join(captured, 'second.ts')))(
  'preserves the captured non-IDR seam despite a clean HTTP body ending mid-TS-packet', async () => {
    const first = await readFile(path.join(captured, 'first.ts'));
    const second = await readFile(path.join(captured, 'second.ts'));
    const upstream = express();
    let requests = 0;
    upstream.get('/api/stream/channel-a', async (_req, res) => {
      requests++;
      res.type('video/mp2t');
      if (requests === 1) { res.write(first); res.end(); return; }
      if (requests === 2) {
        for (let offset = 0; offset < second.length; offset += 64 * 1024) {
          if (res.destroyed) return;
          res.write(second.subarray(offset, offset + 64 * 1024));
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        res.end();
        return;
      }
      const nullPacket = Buffer.alloc(188, 0xff);
      nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
      const nullTransport = Buffer.concat(Array.from({ length: 100 }, () => nullPacket));
      const pace = setInterval(() => {
        if (res.destroyed) { clearInterval(pace); return; }
        res.write(nullTransport); // valid TS null PID; no unverified media
      }, 400);
      res.once('close', () => clearInterval(pace));
    });
    const proxy = await listen(upstream);
    const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-captured-'));
    roots.push(root);
    const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, stallMs: 15000,
      maxBytesPerChannel: 64 * 1024 * 1024, maxSegmentBytes: 12 * 1024 * 1024 });
    buffers.push(buffer);
    const url = `${proxy}/api/stream/channel-a`;
    let observedSequence = -1;
    let observedSegments = 0;
    const manifest = await waitFor(async () => {
      const current = await buffer.playlist('channel-a', url);
      observedSequence = Number(current?.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? -1);
      observedSegments = (current?.match(/^segment\//gm) ?? []).length;
      // Snapshot while the rolling HLS window straddles the non-IDR seam.
      // Waiting for the NEXT EOF would evict the boundary on this fast local
      // source and only decode an unrelated tail.
      return requests >= 2 && current && observedSequence >= 25 && observedSequence <= 34
        && observedSequence + observedSegments - 1 >= 39 ? current : null;
    }, 25000).catch(() => { throw Error(`captured seam not published: sessions=${requests} active=${buffer.activeCount} sequence=${observedSequence} segments=${observedSegments}`); });
    expect(manifest).not.toContain('#EXT-X-DISCONTINUITY\n');
    expect(buffer.activeCount).toBe(1);
    const saved = await mkdtemp(path.join(tmpdir(), 'sv-packet-captured-decode-'));
    roots.push(saved);
    const lines = manifest.split('\n').filter(line => line.startsWith('segment/'));
    for (const [index, line] of lines.entries()) {
      const parsed = new URL(line, 'http://127.0.0.1');
      const id = Number(parsed.pathname.match(/\/(\d+)\.ts$/)?.[1]);
      const epoch = parsed.searchParams.get('epoch')!;
      const stream = await buffer.segment('channel-a', id, epoch);
      expect(stream && stream !== 'busy').toBe(true);
      const chunks: Buffer[] = [];
      for await (const part of stream as NodeJS.ReadableStream) chunks.push(Buffer.from(part));
      await writeFile(path.join(saved, `${index}.ts`), Buffer.concat(chunks));
    }
    await writeFile(path.join(saved, 'index.m3u8'),
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${lines.map((_, i) => `#EXTINF:2,\n${i}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`);
    const identify = spawnSync('/usr/bin/python3', ['-c', `
import av,sys
with av.open(sys.argv[1]) as new, av.open(sys.argv[2]) as played:
  sample = [p for p in new.demux(video=0) if p.size]
  packets = [p for p in played.demux(video=0) if p.size]
  unique = sample[520]  # first unmatched non-IDR picture in this natural-EOF pair
  print('1' if not unique.is_keyframe and sum(bytes(p)==bytes(unique) for p in packets)==1 else '0')
`, path.join(captured, 'second.ts'), path.join(saved, 'index.m3u8')], { timeout: 30000 });
    expect(identify.status).toBe(0);
    expect(identify.stdout.toString().trim()).toBe('1');
    const decode = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
      '-i', path.join(saved, 'index.m3u8'), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 60000 });
    expect(decode.status).toBe(0);
    expect(decode.stderr.toString()).toBe('');
  }, 120000,
);

it.each(['chunked', 'length'] as const)('serves one signed, continuous HLS timeline over authenticated %s proxy EOFs', async framing => {
  process.env.STREAMVAULT_AUTH_TOKEN = 'test-only-local-token';
  const [first, second] = await media();
  const upstream = express();
  let requests = 0;
  let authorized = true;
  upstream.get('/api/stream/channel-a', (req, res) => {
    if (req.header('authorization') !== 'Bearer test-only-local-token') { authorized = false; res.status(401).end(); return; }
    const requestCount = ++requests;
    const body = requestCount === 1 ? first : second;
    res.type('video/mp2t');
    if (requestCount > 2) { res.write(body.subarray(0, 188)); return; }
    if (framing === 'length') res.set('Content-Length', String(body.length));
    if (framing === 'chunked') {
      for (let i = 0; i < body.length; i += 1316) res.write(body.subarray(i, i + 1316));
      res.end();
    } else res.end(body);
  });
  const proxy = await listen(upstream);
  const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-cache-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, retryMs: 200,
    maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000 });
  buffers.push(buffer);
  const app = express();
  app.use('/api/live', createLiveRouter(buffer, id => id === 'channel-a' ? `${proxy}/api/stream/${id}` : null));
  const base = await listen(app);
  expect((await fetch(`${base}/api/live/channel-a/index.m3u8`)).status).toBe(401);
  const authorization = await fetch(`${base}/api/live/channel-a/authorize`, { headers: { authorization: 'Bearer test-only-local-token' } });
  expect(authorization.status, `requests=${requests} authenticated=${authorized} active=${buffer.activeCount}`).toBe(200);
  const { playlistUrl } = await authorization.json();
  const playlist = new URL(playlistUrl, base);
  const manifest = await waitFor(async () => {
    const res = await fetch(playlist);
    if (!res.ok) return null;
    const text = await res.text();
    return requests >= 2 && (text.match(/^segment\//gm) ?? []).length >= 5 ? text : null;
  });
  expect(authorized).toBe(true);
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(manifest.includes('\n#EXT-X-DISCONTINUITY\n')).toBe(false);
  expect(manifest.includes('#EXT-X-ENDLIST')).toBe(false);
  const segments = manifest.split('\n').filter(line => line.startsWith('segment/'));
  expect(segments.every(line => line.includes('ticket='))).toBe(true);
  expect((await fetch(new URL(segments[0].split('?')[0], playlist))).status).toBe(401);
  const saved = await mkdtemp(path.join(tmpdir(), 'sv-packet-decode-'));
  roots.push(saved);
  for (const [index, segment] of segments.entries()) {
    const res = await fetch(new URL(segment, playlist));
    expect(res.status).toBe(200);
    await writeFile(path.join(saved, `${index}.ts`), Buffer.from(await res.arrayBuffer()));
  }
  const local = segments.map((_, index) => `#EXTINF:2,\n${index}.ts`).join('\n');
  await writeFile(path.join(saved, 'index.m3u8'), `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${local}\n#EXT-X-ENDLIST\n`);
  const decode = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
    '-i', path.join(saved, 'index.m3u8'), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 20000 });
  expect(decode.status).toBe(0);
  expect(decode.stderr.toString()).toBe('');
  // Compare the real served HLS inventory, not just its manifest syntax.
  // The first unique successor H.264 picture is non-IDR and must survive.
  const inventory = spawnSync('/usr/bin/python3', ['-c', `
import av,sys
def tracks(name):
  result = {'video':[], 'audio':[]}
  with av.open(name) as media:
    for pkt in media.demux():
      if pkt.size and pkt.stream.type in result: result[pkt.stream.type].append((bytes(pkt), pkt.is_keyframe))
  return result
baseline, served, replay = tracks(sys.argv[1]), tracks(sys.argv[2]), tracks(sys.argv[3])
unique = replay['video'][60]
ok = not unique[1] and unique[0] in [p[0] for p in served['video']]
for kind in ('video','audio'):
  expected = [p[0] for p in baseline[kind]]
  actual = [p[0] for p in served[kind]]
  ok = ok and bool(actual) and any(expected[i:i+len(actual)] == actual for i in range(len(expected)-len(actual)+1))
print('1' if ok else '0')
`, path.join(roots[0], 'full.ts'), path.join(saved, 'index.m3u8'), path.join(roots[0], 'second.ts')], { timeout: 20000 });
  expect(inventory.status).toBe(0);
  expect(inventory.stdout.toString().trim()).toBe('1');
}, 40000);

it.each(['shifted-audio', 'missing-video', 'incompatible-video', 'truncated-length', 'silent-source'] as const)(
  'invalidates cached segments and latches fail-closed on %s', async failure => {
    process.env.STREAMVAULT_AUTH_TOKEN = 'test-only-local-token';
    const [first, originalSecond] = await media();
    const fixtureDir = roots[0];
    let second = originalSecond;
    if (failure === 'shifted-audio' || failure === 'missing-video') {
      const edit = spawnSync('/usr/bin/python3', ['-c', `
import av,sys
with av.open(sys.argv[1]) as src, av.open(sys.argv[2], 'w', format='mpegts') as dst:
  mapped = {s.index:dst.add_stream_from_template(s) for s in src.streams}
  video = 0
  for p in src.demux():
    if not p.size: continue
    if p.stream.type == 'video':
      video += 1
      if sys.argv[3] == 'missing-video' and video == 16: continue
    if p.stream.type == 'audio' and sys.argv[3] == 'shifted-audio': p.pts += 1920; p.dts += 1920
    p.stream = mapped[p.stream.index]; dst.mux(p)
`, path.join(fixtureDir, 'second.ts'), path.join(fixtureDir, 'bad.ts'), failure], { timeout: 20000 });
      expect(edit.status).toBe(0);
      second = await readFile(path.join(fixtureDir, 'bad.ts'));
    }
    if (failure === 'incompatible-video') {
      const edit = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-i', path.join(fixtureDir, 'second.ts'), '-c:v', 'mpeg2video', '-c:a', 'copy',
        '-f', 'mpegts', path.join(fixtureDir, 'bad.ts')], { timeout: 20000 });
      expect(edit.status).toBe(0);
      second = await readFile(path.join(fixtureDir, 'bad.ts'));
    }
    const upstream = express();
    let requests = 0;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    upstream.get('/api/stream/channel-a', async (req, res) => {
      if (req.header('authorization') !== 'Bearer test-only-local-token') { res.status(401).end(); return; }
      const count = ++requests;
      res.type('video/mp2t');
      if (count === 1) { res.set('Content-Length', String(first.length)); res.end(first); return; }
      await waiting;
      if (failure === 'silent-source') { res.write(second.subarray(0, 188)); return; }
      if (failure === 'truncated-length') res.set('Content-Length', String(second.length + 188));
      else res.set('Content-Length', String(second.length));
      res.end(second);
    });
    const proxy = await listen(upstream);
    const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-negative-'));
    roots.push(root);
    const buffer = createLiveBuffer({ root, packetAware: true, pollMs: 100, retryMs: 100,
      maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000,
      stallMs: 15000 });
    buffers.push(buffer);
    const app = express();
    app.use('/api/live', createLiveRouter(buffer, id => id === 'channel-a' ? `${proxy}/api/stream/${id}` : null));
    const base = await listen(app);
    await waitFor(async () => buffer.playlist('channel-a', `${proxy}/api/stream/channel-a`), 18000);
    const ticket = await waitFor(async () => {
      const response = await fetch(`${base}/api/live/channel-a/authorize`, { headers: { authorization: 'Bearer test-only-local-token' } });
      return response.status === 200 ? response : null;
    }, 18000);
    const { playlistUrl } = await ticket.json();
    const playlist = new URL(playlistUrl, base);
    const manifest = await waitFor(async () => {
      const res = await fetch(playlist);
      if (!res.ok) return null;
      const text = await res.text();
      return text.includes('segment/') ? text : null;
    });
    const firstSegment = manifest.split('\n').find(line => line.startsWith('segment/'))!;
    expect((await fetch(new URL(firstSegment, playlist))).status).toBe(200);
    release();
    await waitFor(async () => buffer.activeCount === 0 ? true : null, 10000);
    expect((await fetch(new URL(firstSegment, playlist))).status).toBe(404);
    expect((await fetch(playlist)).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(requests).toBe(2);
  }, 35000,
);

it('reserves a packet channel, bounds cached readers, and removes cache on shutdown', async () => {
  const [first] = await media();
  const upstream = express();
  let requests = 0;
  upstream.get('/api/stream/channel-a', (_req, res) => {
    requests++;
    res.type('video/mp2t');
    if (requests === 1) { res.set('Content-Length', String(first.length)); res.end(first); }
    else res.write(first.subarray(0, 188));
  });
  const proxy = await listen(upstream);
  const root = await mkdtemp(path.join(tmpdir(), 'sv-packet-stop-'));
  roots.push(root);
  const buffer = createLiveBuffer({ root, packetAware: true, maxChannels: 1, maxReaders: 1,
    maxBytesPerChannel: 8_000_000, maxSegmentBytes: 2_000_000, pollMs: 100, stallMs: 5000 });
  buffers.push(buffer);
  const url = `${proxy}/api/stream/channel-a`;
  const pending = buffer.playlist('channel-a', url);
  expect(await buffer.playlist('channel-b', `${proxy}/api/stream/channel-b`)).toBeNull();
  await pending;
  const manifest = await waitFor(async () => buffer.playlist('channel-a', url));
  const segment = manifest.split('\n').find(line => line.startsWith('segment/'))!;
  const parsed = new URL(segment, 'http://127.0.0.1');
  const id = Number(parsed.pathname.match(/\/(\d+)\.ts$/)?.[1]);
  const epoch = parsed.searchParams.get('epoch')!;
  const reader = await buffer.segment('channel-a', id, epoch);
  expect(reader && reader !== 'busy').toBe(true);
  expect(await buffer.segment('channel-a', id, epoch)).toBe('busy');
  if (reader && reader !== 'busy') {
    const closed = new Promise(resolve => reader.once('close', resolve));
    reader.destroy();
    await closed;
  }
  await buffer.stop();
  expect(buffer.activeCount).toBe(0);
  expect(buffer.activeReaders).toBe(0);
  expect(await readdir(root)).toEqual([]);
  expect(await buffer.segment('channel-a', id, epoch)).toBeNull();
}, 45000);

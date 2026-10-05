import { Router, type Request } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAuthorizedRequest } from './security.js';

interface Segment { id: number; name: string; duration: number; bytes: number; discontinuity: boolean; }
interface Channel {
  id: string; dir: string; epoch: string; segments: Segment[]; bytes: number; sequence: number; discontinuitySequence: number;
  lastAccess: number; lastPublish: number; worker?: ChildProcess; working?: string;
  generation: number; lastStageIndex: number; timer?: ReturnType<typeof setInterval>; terminating: boolean; retirement?: Promise<void>;
  inspecting?: boolean; publishTask?: Promise<void>;
}
export interface LiveBufferOptions {
  root?: string; maxChannels?: number; maxBytesPerChannel?: number; maxSegmentBytes?: number; maxReaders?: number;
  stallMs?: number; idleMs?: number; retryMs?: number; pollMs?: number; segmentSeconds?: number;
  minFreeBytes?: number; removeChannelDir?: (dir: string) => Promise<void>;
}

export function newStageIndices(indices: number[], last: number): number[] | null {
  const fresh: number[] = [];
  let expected = last + 1;
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    if (index <= last) continue;
    if (index !== expected) return null;
    fresh.push(index);
    expected++;
  }
  return fresh;
}

/** One FFmpeg ingest per channel, never one per viewer. No archive files are touched. */
export function createLiveBuffer(options: LiveBufferOptions = {}) {
  const root = options.root ?? path.join(process.env.TMPDIR || tmpdir(), 'streamvault-live-buffer');
  const maxChannels = options.maxChannels ?? 4;
  const maxBytes = options.maxBytesPerChannel ?? 64 * 1024 * 1024;
  const maxSegmentBytes = options.maxSegmentBytes ?? 12 * 1024 * 1024;
  const maxReaders = options.maxReaders ?? 16;
  const stallMs = options.stallMs ?? 15_000;
  const idleMs = options.idleMs ?? 60_000;
  const retryMs = options.retryMs ?? 2_000;
  const pollMs = options.pollMs ?? 500;
  const segmentSeconds = options.segmentSeconds ?? 2;
  const minFreeBytes = options.minFreeBytes ?? 128 * 1024 * 1024;
  const removeChannelDir = options.removeChannelDir ?? (dir => rm(dir, { recursive: true, force: true }));
  if (![maxChannels, maxBytes, maxSegmentBytes, maxReaders, stallMs, idleMs, retryMs, pollMs, segmentSeconds, minFreeBytes]
    .every(n => Number.isFinite(n) && n > 0) || maxBytes < maxSegmentBytes * 2 || !Number.isInteger(maxReaders)) throw Error('Invalid live buffer limits');
  const channels = new Map<string, Channel>();
  let activeReaders = 0;
  let stopped = false;
  // Keep HLS media sequence modest and monotonic per channel within a process.
  // Segment URLs also carry an opaque worker epoch, so an old URL cannot alias
  // different media after idle retirement or a service restart.
  const sequenceByChannel = new Map<string, number>();
  let initialized: Promise<void> | undefined;
  const initialize = () => initialized ??= (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // These directories are disposable cache only, never archive or saved media.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('channel-'))
        await rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  })();

  function retire(ch: Channel): Promise<void> {
    if (ch.retirement) return ch.retirement;
    ch.terminating = true;
    if (ch.timer) clearInterval(ch.timer);
    // Keep this slot reserved and tracked until the worker and disposable
    // directory are gone; shutdown can join a retirement already in progress.
    ch.retirement = (async () => {
      try {
        const worker = ch.worker;
        if (worker && worker.exitCode === null) worker.kill('SIGKILL');
        if (worker && worker.exitCode === null) await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 1000);
          worker.once('close', () => { clearTimeout(timeout); resolve(); });
        });
        if (ch.dir) await removeChannelDir(ch.dir).catch(() => {});
      } finally {
        if (channels.get(ch.id) === ch) channels.delete(ch.id);
      }
    })();
    return ch.retirement;
  }

  async function publish(ch: Channel) {
    if (!ch.working || ch.terminating) return;
    // FFmpeg's HLS muxer writes separate WebVTT assets, which this endpoint
    // cannot expose as selectable renditions. Fall back to legacy TS instead
    // of silently serving video without the original subtitle track.
    try {
      if ((await readdir(ch.working)).some(name => name.endsWith('.vtt') || name.endsWith('_vtt.m3u8'))) {
        await retire(ch); return;
      }
    } catch { return; }
    let manifest: string;
    try { manifest = await readFile(path.join(ch.working, 'index.m3u8'), 'utf8'); }
    catch { return; }
    const entries = [...manifest.matchAll(/#EXTINF:([\d.]+),?[^\n]*\n([^\r\n]+\.ts)/g)];
    const indices = entries.map(([, , name]) => /^\d+\.ts$/.test(name) ? Number(name.slice(0, -3)) : NaN);
    if (!newStageIndices(indices, ch.lastStageIndex)) { await retire(ch); return; }
    for (const [, durationText, name] of entries) {
      if (ch.terminating) return;
      const index = Number(name.slice(0, -3));
      if (index <= ch.lastStageIndex) continue;
      const key = `${ch.generation}-${name}`;
      const duration = Number(durationText);
      // Never conceal a unique segment by skipping an unpublishable input.
      if (!Number.isFinite(duration) || duration <= 0 || duration > 4) { await retire(ch); return; }
      let data: Buffer;
      try {
        const stage = path.join(ch.working, name);
        if ((await stat(stage)).size > maxSegmentBytes) { await retire(ch); return; }
        data = await readFile(stage);
      } catch { await retire(ch); return; }
      if (!data.length || data.length > maxSegmentBytes || ch.terminating) { await retire(ch); return; }
      try {
        const space = await statfs(root);
        if (space.bavail * space.bsize < minFreeBytes + data.length) { void retire(ch); return; }
      } catch { void retire(ch); return; }
      const id = ch.sequence++;
      sequenceByChannel.set(ch.id, ch.sequence);
      const filename = `${id}.ts`;
      try { await writeFile(path.join(ch.dir, filename), data, { flag: 'wx' }); }
      catch { void retire(ch); return; }
      ch.lastStageIndex = index;
      const discontinuity = ch.segments.length > 0 && ch.segments.at(-1)!.name.split('-')[0] !== String(ch.generation);
      ch.segments.push({ id, name: key, duration, bytes: data.length, discontinuity });
      ch.bytes += data.length;
      ch.lastPublish = Date.now();
      while ((ch.bytes > maxBytes || ch.segments.length > 12) && ch.segments.length > 1) {
        const old = ch.segments.shift()!;
        ch.bytes -= old.bytes;
        if (old.discontinuity) ch.discontinuitySequence++;
        void rm(path.join(ch.dir, `${old.id}.ts`), { force: true });
      }
    }
  }

  function publishInOrder(ch: Channel): Promise<void> {
    const next = (ch.publishTask ?? Promise.resolve()).then(() => publish(ch));
    ch.publishTask = next;
    void next.finally(() => { if (ch.publishTask === next) ch.publishTask = undefined; }).catch(() => {});
    return next;
  }

  async function inspect(ch: Channel) {
    if (ch.terminating || stopped || ch.inspecting) return;
    ch.inspecting = true;
    try {
      const now = Date.now();
      if (now - ch.lastAccess > idleMs) { await retire(ch); return; }
      if (ch.working) {
        // Inspect even incomplete and temporary files: a stalled/high-bitrate source
        // may otherwise fill the mount before FFmpeg publishes its first segment.
        try {
          const space = await statfs(root);
          if (space.bavail * space.bsize < minFreeBytes) { await retire(ch); return; }
          let total = 0;
          for (const name of await readdir(ch.working)) {
            const size = (await stat(path.join(ch.working, name))).size;
            total += size;
            if (name.endsWith('.ts') && size > maxSegmentBytes) { await retire(ch); return; }
          }
          if (total + ch.bytes > maxBytes + maxSegmentBytes * 4) { await retire(ch); return; }
        } catch { /* writer may be closing or replacing the directory */ }
        await publishInOrder(ch);
        if (Date.now() - ch.lastPublish > stallMs) ch.worker?.kill('SIGKILL');
      }
    } finally { ch.inspecting = false; }
  }

  async function launch(ch: Channel, url: string) {
    if (ch.terminating || stopped || ch.worker) return;
    try {
      const space = await statfs(root);
      if (space.bavail * space.bsize < minFreeBytes + maxBytes + maxSegmentBytes * 4) {
        await retire(ch); return;
      }
    } catch { await retire(ch); return; }
    if (ch.terminating || stopped) return;
    const generation = ++ch.generation;
    ch.lastStageIndex = -1;
    const working = await mkdtemp(path.join(ch.dir, 'ingest-'));
    if (ch.terminating || stopped) { await rm(working, { recursive: true, force: true }); return; }
    ch.working = working;
    ch.lastPublish = Date.now();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', url,
      '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-f', 'hls',
      '-hls_time', String(segmentSeconds), '-hls_list_size', '16',
      '-hls_flags', 'delete_segments+omit_endlist+temp_file',
      '-hls_segment_filename', path.join(working, '%d.ts'), path.join(working, 'index.m3u8')];
    // Never log FFmpeg arguments/stderr: upstream URL paths may embed credentials.
    const worker = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    ch.worker = worker;
    worker.on('error', () => {});
    worker.once('close', () => {
      void (async () => {
        if (ch.terminating || generation !== ch.generation) return;
        await publishInOrder(ch); // FFmpeg may have finalized its last segment at EOF.
        ch.working = undefined;
        ch.worker = undefined;
        await rm(working, { recursive: true, force: true }).catch(() => {});
        if (ch.terminating || stopped || Date.now() - ch.lastAccess >= idleMs) { await retire(ch); return; }
        setTimeout(() => { if (!ch.terminating && !stopped && ch.generation === generation) void launch(ch, url).catch(() => void retire(ch)); }, retryMs).unref();
      })();
    });
  }

  async function get(id: string, url: string) {
    let ch = channels.get(id);
    if (ch) {
      if (ch.terminating) return null;
      ch.lastAccess = Date.now(); return ch;
    }
    if (stopped || channels.size >= maxChannels) return null;
    ch = { id, dir: '', epoch: randomBytes(8).toString('hex'), segments: [], bytes: 0,
      sequence: sequenceByChannel.get(id) ?? 0, discontinuitySequence: 0,
      generation: 0, lastStageIndex: -1, lastAccess: Date.now(), lastPublish: Date.now(), terminating: false };
    channels.set(id, ch); // reserve slot before the first await
    try {
      await initialize();
      ch.dir = await mkdtemp(path.join(root, 'channel-'));
      if (ch.terminating || stopped) { await retire(ch); return null; }
      ch.timer = setInterval(() => { void inspect(ch!).catch(() => void retire(ch!)); }, pollMs);
      ch.timer.unref();
      void launch(ch, url).catch(() => void retire(ch));
      return ch;
    } catch { await retire(ch); return null; }
  }

  return {
    get activeCount() { return channels.size; },
    get activeReaders() { return activeReaders; },
    async playlist(id: string, url: string, ticket?: string) {
      const ch = await get(id, url);
      if (!ch || !ch.segments.length) return null;
      const rows = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
        `#EXT-X-MEDIA-SEQUENCE:${ch.segments[0].id}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${ch.discontinuitySequence}`];
      for (const seg of ch.segments) {
        if (seg.discontinuity) rows.push('#EXT-X-DISCONTINUITY');
        rows.push(`#EXTINF:${seg.duration.toFixed(3)},`, `segment/${seg.id}.ts?epoch=${ch.epoch}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''}`);
      }
      return `${rows.join('\n')}\n`;
    },
    async segment(id: string, segmentId: number, epoch: string) {
      const ch = channels.get(id);
      if (!ch || ch.epoch !== epoch) return null;
      ch.lastAccess = Date.now();
      const seg = ch.segments.find(s => s.id === segmentId);
      if (!seg) return null;
      if (activeReaders >= maxReaders) return 'busy' as const;
      activeReaders++;
      try {
        // Pin the inode before eviction. A slow viewer holds only one 64 KiB
        // stream buffer rather than an entire (potentially 12 MiB) segment.
        const handle = await open(path.join(ch.dir, `${seg.id}.ts`), 'r');
        const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
        stream.once('close', () => { activeReaders--; });
        return stream;
      } catch { activeReaders--; return null; }
    },
    async stop() { stopped = true; await Promise.all([...channels.values()].map(retire)); },
  };
}

export function createLiveRouter(buffer: ReturnType<typeof createLiveBuffer>, source: (id: string) => string | null | undefined) {
  const router = Router();
  const secret = randomBytes(32);
  const ttl = 24 * 60 * 60_000;
  let authorizationWaiters = 0;
  const signature = (id: string, expiry: number) => createHmac('sha256', secret).update(`${id}\u001f${expiry}`).digest('base64url');
  const ticketFor = (id: string) => { const expiresAt = Date.now() + ttl; return { ticket: `${expiresAt}.${signature(id, expiresAt)}`, expiresAt }; };
  const allowed = (req: Request, id: string) => {
    const token = process.env.STREAMVAULT_AUTH_TOKEN;
    if (!token || isAuthorizedRequest(req.header('authorization') || undefined, token, req.header('x-streamvault-token') || undefined)) return true;
    const ticket = req.query.ticket;
    if (typeof ticket !== 'string' || ticket.length > 128 || !/^\d{13}\.[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
    const expiry = Number(ticket.slice(0, 13));
    if (expiry < Date.now() || expiry > Date.now() + ttl || !Number.isSafeInteger(expiry)) return false;
    const actual = Buffer.from(ticket.slice(14));
    const expected = Buffer.from(signature(id, expiry));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const prepare = (req: Request, res: import('express').Response, id: string) => {
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
    if (!allowed(req, id)) { res.status(401).end(); return null; }
    const url = source(id);
    if (!url || !/^https?:\/\//i.test(url)) { res.status(404).end(); return null; }
    if (req.query.audio === '1') { res.status(422).json({ error: 'Audio-only live HLS is not supported' }); return null; }
    return url;
  };
  router.get('/:id/authorize', async (req, res) => {
    const id = String(req.params.id);
    const applicationToken = process.env.STREAMVAULT_AUTH_TOKEN;
    if (!isAuthorizedRequest(req.header('authorization') || undefined, applicationToken,
      req.header('x-streamvault-token') || undefined)) { res.status(401).end(); return; }
    const url = source(id);
    if (!url) { res.status(404).end(); return; }
    if (req.query.audio === '1') { res.status(422).end(); return; }
    // Native players may not retry an initial 503 playlist. Wait briefly for
    // a published segment; otherwise let the caller use its legacy TS path.
    if (authorizationWaiters >= 8) { res.set('Retry-After', '2').status(503).end(); return; }
    authorizationWaiters++;
    let ready = false;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !req.destroyed) {
        const manifest = await buffer.playlist(id, url);
        if (manifest?.includes('\nsegment/')) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally { authorizationWaiters--; }
    if (req.destroyed) return;
    if (!ready) { res.set('Retry-After', '2').status(503).end(); return; }
    const { ticket, expiresAt } = ticketFor(id);
    res.set('Cache-Control', 'private, no-store').json({ playlistUrl: `/api/live/${encodeURIComponent(id)}/index.m3u8?ticket=${ticket}`, expiresAt });
  });
  router.get('/:id/index.m3u8', async (req, res) => {
    const id = String(req.params.id);
    const url = prepare(req, res, id);
    if (!url) return;
    const ticket = typeof req.query.ticket === 'string' && allowed(req, id) ? req.query.ticket : undefined;
    try {
      const manifest = await buffer.playlist(id, url, ticket);
      if (!manifest) { res.set('Retry-After', '2').status(503).end(); return; }
      res.type('application/vnd.apple.mpegurl').send(manifest);
    } catch { res.status(503).end(); }
  });
  router.get('/:id/segment/:segmentId.ts', async (req, res) => {
    const id = String(req.params.id);
    if (!prepare(req, res, id)) return;
    const rawId = String(req.params.segmentId);
    if (!/^\d{1,15}$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) { res.status(404).end(); return; }
    const epoch = typeof req.query.epoch === 'string' ? req.query.epoch : '';
    // The viewer may disconnect while the file descriptor is opening. Observe
    // close before awaiting, then destroy a stream that arrives after close.
    let disconnected = res.destroyed;
    let destroyStream: (() => void) | null = null;
    res.once('close', () => { disconnected = true; destroyStream?.(); });
    const stream = await buffer.segment(id, Number(rawId), epoch);
    if (stream === 'busy') { if (!disconnected) res.set('Retry-After', '1').status(503).end(); return; }
    if (!stream) { if (!disconnected) res.status(404).end(); return; }
    destroyStream = () => stream.destroy();
    if (disconnected || res.destroyed) { stream.destroy(); return; }
    res.type('video/mp2t');
    stream.once('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else res.status(503).end();
    });
    stream.pipe(res);
  });
  return router;
}

import { Router, type Request } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorizedRequest } from './security.js';

interface Segment { id: number; name: string; duration: number; bytes: number; discontinuity: boolean; }
export const packetAwareLiveEnabled = (value: string | undefined): boolean => value === '1';
// Stream-copy HLS cuts at source keyframes, not the requested two-second cadence.
// Keep the advertised upper bound fixed for the lifetime of every playlist.
export const LIVE_HLS_MAX_SEGMENT_SECONDS = 12;
interface Channel {
  id: string; dir: string; epoch: string; segments: Segment[]; bytes: number; sequence: number; discontinuitySequence: number;
  lastAccess: number; lastPublish: number; worker?: ChildProcess; working?: string;
  generation: number; lastStageIndex: number; timer?: ReturnType<typeof setInterval>; terminating: boolean; retirement?: Promise<void>;
  inspecting?: boolean; publishTask?: Promise<void>;
}
export interface LiveBufferOptions {
  root?: string; maxChannels?: number; maxBytesPerChannel?: number; maxSegmentBytes?: number; maxReaders?: number;
  stallMs?: number; maxUnpublishedMs?: number; idleMs?: number; retryMs?: number; pollMs?: number; segmentSeconds?: number;
  minFreeBytes?: number; removeChannelDir?: (dir: string) => Promise<void>;
  unsafeMarkerStat?: (file: string) => Promise<void>;
  onUnsafe?: (reason: string, id?: string) => void; // fixed, non-URL diagnostic categories
  packetAware?: boolean;
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
  const maxUnpublishedMs = options.maxUnpublishedMs ?? 45_000;
  const idleMs = options.idleMs ?? 60_000;
  const retryMs = options.retryMs ?? 2_000;
  const pollMs = options.pollMs ?? 500;
  const segmentSeconds = options.segmentSeconds ?? 2;
  const minFreeBytes = options.minFreeBytes ?? 128 * 1024 * 1024;
  const removeChannelDir = options.removeChannelDir ?? (dir => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const unsafeMarkerStat = options.unsafeMarkerStat ?? (async (file: string) => { await stat(file); });
  const packetAware = options.packetAware ?? false;
  if (![maxChannels, maxBytes, maxSegmentBytes, maxReaders, stallMs, maxUnpublishedMs, idleMs, retryMs, pollMs, segmentSeconds, minFreeBytes]
    .every(n => Number.isFinite(n) && n > 0) || maxBytes < maxSegmentBytes * 2 || !Number.isInteger(maxReaders)) throw Error('Invalid live buffer limits');
  const channels = new Map<string, Channel>();
  const unsafeChannels = new Set<string>();
  let unsafeCapacityExhausted = false;
  const isUnsafe = (id: string): boolean => packetAware && (unsafeCapacityExhausted || unsafeChannels.has(id));
  function markUnsafe(id: string, reason = 'worker_exit') {
    // Bound failed-ID accounting; if exhausted, reject ALL new packet channels
    // until restart rather than forgetting an unsafe one and retrying it.
    options.onUnsafe?.(reason, id);
    if (unsafeChannels.size >= maxChannels * 16) unsafeCapacityExhausted = true;
    else unsafeChannels.add(id);
  }
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
        if (worker && worker.exitCode === null && worker.signalCode === null) {
          // Let Python close its FFmpeg child and HTTP socket. A direct SIGKILL
          // orphans the muxer, which can keep writing into a retired directory.
          const waitClose = (ms: number) => new Promise<void>(resolve => {
            const onClose = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { worker.off('close', onClose); resolve(); }, ms);
            worker.once('close', onClose);
          });
          const graceful = waitClose(packetAware ? 5_000 : 1_000);
          worker.kill(packetAware ? 'SIGTERM' : 'SIGKILL');
          await graceful;
          if (packetAware && worker.exitCode === null && worker.signalCode === null) {
            const forced = waitClose(1_000);
            worker.kill('SIGKILL');
            await forced;
          }
        }
        if (ch.dir) await removeChannelDir(ch.dir).catch(() => {});
      } finally {
        if (channels.get(ch.id) === ch) channels.delete(ch.id);
      }
    })();
    return ch.retirement;
  }

  function retireUnsafe(ch: Channel, reason = 'unpublishable_stage'): Promise<void> {
    if (packetAware && !ch.terminating) markUnsafe(ch.id, reason);
    return retire(ch);
  }

  async function publish(ch: Channel) {
    if (!ch.working || ch.terminating) return;
    if (packetAware) {
      try { await unsafeMarkerStat(path.join(ch.working, 'UNSAFE')); markUnsafe(ch.id, 'worker_unsafe'); await retire(ch); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await retireUnsafe(ch, 'marker_unreadable'); return; } }
    }
    // FFmpeg's HLS muxer writes separate WebVTT assets, which this endpoint
    // cannot expose as selectable renditions. Fall back to legacy TS instead
    // of silently serving video without the original subtitle track.
    try {
      if ((await readdir(ch.working)).some(name => name.endsWith('.vtt') || name.endsWith('_vtt.m3u8'))) {
        await retireUnsafe(ch); return;
      }
    } catch { return; }
    let manifest: string;
    try { manifest = await readFile(path.join(ch.working, 'index.m3u8'), 'utf8'); }
    catch { return; }
    const entries = [...manifest.matchAll(/#EXTINF:([\d.]+),?[^\n]*\n([^\r\n]+\.ts)/g)];
    const indices = entries.map(([, , name]) => /^\d+\.ts$/.test(name) ? Number(name.slice(0, -3)) : NaN);
    if (!newStageIndices(indices, ch.lastStageIndex)) { await retireUnsafe(ch, 'stage_index_gap'); return; }
    for (const [, durationText, name] of entries) {
      if (ch.terminating) return;
      const index = Number(name.slice(0, -3));
      if (index <= ch.lastStageIndex) continue;
      const key = `${ch.generation}-${name}`;
      const duration = Number(durationText);
      // Never conceal a unique segment by skipping an unpublishable input.
      if (!Number.isFinite(duration) || duration <= 0 || duration > LIVE_HLS_MAX_SEGMENT_SECONDS) { await retireUnsafe(ch); return; }
      const stage = path.join(ch.working, name);
      let data: Buffer;
      try {
        if ((await stat(stage)).size > maxSegmentBytes) { await retireUnsafe(ch); return; }
        data = await readFile(stage);
      } catch { await retireUnsafe(ch); return; }
      if (ch.terminating) return;
      if (!data.length || data.length > maxSegmentBytes) { await retireUnsafe(ch); return; }
      try {
        const space = await statfs(root);
        if (space.bavail * space.bsize < minFreeBytes + data.length) { void retireUnsafe(ch); return; }
      } catch { void retireUnsafe(ch); return; }
      const id = ch.sequence++;
      sequenceByChannel.set(ch.id, ch.sequence);
      const filename = `${id}.ts`;
      try { await writeFile(path.join(ch.dir, filename), data, { flag: 'wx' }); }
      catch { void retireUnsafe(ch); return; }
      ch.lastStageIndex = index;
      const discontinuity = ch.segments.length > 0 && ch.segments.at(-1)!.name.split('-')[0] !== String(ch.generation);
      ch.segments.push({ id, name: key, duration, bytes: data.length, discontinuity });
      ch.bytes += data.length;
      ch.lastPublish = Date.now();
      // The served copy is now independent of FFmpeg's rolling staging list.
      // Reclaim published stage bytes so a longer manifest can absorb bursts
      // without retaining an unbounded second copy of the media.
      await rm(stage, { force: true }).catch(() => {});
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
          if (space.bavail * space.bsize < minFreeBytes) { await retireUnsafe(ch, 'free_space'); return; }
          let total = 0;
          for (const name of await readdir(ch.working)) {
            const size = (await stat(path.join(ch.working, name))).size;
            total += size;
            if (name.endsWith('.ts') && size > maxSegmentBytes) { await retireUnsafe(ch, 'stage_segment_cap'); return; }
          }
          if (total + ch.bytes > maxBytes + maxSegmentBytes * 4) { await retireUnsafe(ch, 'stage_disk_cap'); return; }
        } catch { /* writer may be closing or replacing the directory */ }
        await publishInOrder(ch);
        const unpublishedMs = Date.now() - ch.lastPublish;
        // Input bytes alone are not playable media: null TS packets or a
        // replay that never reaches a unique picture must expire this feed.
        if (packetAware && unpublishedMs > maxUnpublishedMs) {
          await retireUnsafe(ch, 'no_new_segments'); return;
        } else if (unpublishedMs > stallMs) {
          // A packet seam can consume a long replay without publishing new
          // segments. Treat ongoing bounded source reads as forward progress;
          // an actually silent source stops touching this private marker.
          let sourceProgress = 0;
          if (packetAware) {
            try { sourceProgress = (await stat(path.join(ch.working, '.source-progress'))).mtimeMs; }
            catch { /* worker has not started or is closing */ }
          }
          // A cold worker can still be importing PyAV before its first read.
          // Only apply the source-silence deadline once bytes or a segment have
          // existed; the independent first-publication deadline above remains.
          const sourceStarted = !packetAware || sourceProgress > 0 || ch.lastStageIndex >= 0;
          if (sourceStarted && Date.now() - Math.max(ch.lastPublish, sourceProgress) > stallMs) {
            if (packetAware) await retireUnsafe(ch, 'source_stall');
            else ch.worker?.kill('SIGKILL');
            return;
          }
        }
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
    // The packet worker receives only a loopback proxy URL. The token is not
    // passed in argv (or logged); it authenticates the same proxy as capture.
    const worker = packetAware
      ? spawn('/usr/bin/python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'live_packet_worker.py'),
        '--source', url, '--directory', working, '--disk-bytes', String(maxBytes + maxSegmentBytes * 4)],
        { stdio: ['ignore', 'ignore', 'ignore'] })
      : spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    ch.worker = worker;
    worker.on('error', () => {});
    worker.once('close', () => {
      void (async () => {
        if (ch.terminating || generation !== ch.generation) return;
        if (packetAware) {
          // Only an initial transport/HTTP failure before accepting any media
          // can be retried as a fresh presentation on a later authorization.
          // Every failed seam or emitted packet remains latched unavailable.
          const retryable = ch.segments.length === 0 && await stat(path.join(working, 'RETRYABLE'))
            .then(() => true, () => false);
          if (!retryable) markUnsafe(ch.id);
          await retire(ch); return;
        }
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
    if (isUnsafe(id)) return null;
    if (packetAware && (!/^https?:\/\/127\.0\.0\.1:\d+\/api\/stream\/[A-Za-z0-9_-]+(?:\?subs=1)?$/.test(url)
      || !/^[-A-Za-z0-9_]+$/.test(id))) return null;
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
    isUnsafe,
    get activeCount() { return channels.size; },
    get activeReaders() { return activeReaders; },
    async playlist(id: string, url: string, ticket?: string) {
      const ch = await get(id, url);
      if (!ch || !ch.segments.length) return null;
      const rows = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${LIVE_HLS_MAX_SEGMENT_SECONDS}`,
        `#EXT-X-MEDIA-SEQUENCE:${ch.segments[0].id}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${ch.discontinuitySequence}`];
      for (const seg of ch.segments) {
        if (seg.discontinuity) rows.push('#EXT-X-DISCONTINUITY');
        rows.push(`#EXTINF:${seg.duration.toFixed(3)},`, `segment/${seg.id}.ts?epoch=${ch.epoch}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''}`);
      }
      return `${rows.join('\n')}\n`;
    },
    async segment(id: string, segmentId: number, epoch: string) {
      const ch = channels.get(id);
      if (!ch || ch.terminating || ch.epoch !== epoch) return null;
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
    if (buffer.isUnsafe(id)) { res.status(501).end(); return; }
    // Native players may not retry an initial 503 playlist. Wait briefly for
    // a published segment; otherwise let the caller use its legacy TS path.
    if (authorizationWaiters >= 8) { res.set('Retry-After', '2').status(503).end(); return; }
    authorizationWaiters++;
    let ready = false;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !req.destroyed) {
        const manifest = await buffer.playlist(id, url);
        if (buffer.isUnsafe(id)) break;
        if (manifest?.includes('\nsegment/')) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally { authorizationWaiters--; }
    if (req.destroyed) return;
    if (buffer.isUnsafe(id)) { res.status(501).end(); return; }
    if (!ready) { res.set('Retry-After', '2').status(503).end(); return; }
    const { ticket, expiresAt } = ticketFor(id);
    res.set('Cache-Control', 'private, no-store').json({ playlistUrl: `/api/live/${encodeURIComponent(id)}/index.m3u8?ticket=${ticket}`, expiresAt });
  });
  router.get('/:id/index.m3u8', async (req, res) => {
    const id = String(req.params.id);
    const url = prepare(req, res, id);
    if (!url) return;
    if (buffer.isUnsafe(id)) { res.status(501).end(); return; }
    const ticket = typeof req.query.ticket === 'string' && allowed(req, id) ? req.query.ticket : undefined;
    try {
      const manifest = await buffer.playlist(id, url, ticket);
      if (buffer.isUnsafe(id)) { res.status(501).end(); return; }
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

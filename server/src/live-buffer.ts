import { Router, type Request } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAuthorizedRequest } from './security.js';

interface Segment { id: number; name: string; duration: number; bytes: number; discontinuity: boolean; }
interface Channel {
  id: string; dir: string; segments: Segment[]; bytes: number; sequence: number; discontinuitySequence: number;
  lastAccess: number; lastPublish: number; worker?: ChildProcess; working?: string;
  generation: number; timer?: ReturnType<typeof setInterval>; terminating: boolean;
  inspecting?: boolean; publishTask?: Promise<void>;
}
export interface LiveBufferOptions {
  root?: string; maxChannels?: number; maxBytesPerChannel?: number; maxSegmentBytes?: number;
  stallMs?: number; idleMs?: number; retryMs?: number; pollMs?: number; segmentSeconds?: number;
  minFreeBytes?: number;
}

/** One FFmpeg ingest per channel, never one per viewer. No archive files are touched. */
export function createLiveBuffer(options: LiveBufferOptions = {}) {
  const root = options.root ?? path.join(process.env.TMPDIR || tmpdir(), 'streamvault-live-buffer');
  const maxChannels = options.maxChannels ?? 2;
  const maxBytes = options.maxBytesPerChannel ?? 64 * 1024 * 1024;
  const maxSegmentBytes = options.maxSegmentBytes ?? 12 * 1024 * 1024;
  const stallMs = options.stallMs ?? 15_000;
  const idleMs = options.idleMs ?? 60_000;
  const retryMs = options.retryMs ?? 2_000;
  const pollMs = options.pollMs ?? 500;
  const segmentSeconds = options.segmentSeconds ?? 2;
  const minFreeBytes = options.minFreeBytes ?? 128 * 1024 * 1024;
  if (![maxChannels, maxBytes, maxSegmentBytes, stallMs, idleMs, retryMs, pollMs, segmentSeconds, minFreeBytes]
    .every(n => Number.isFinite(n) && n > 0) || maxBytes < maxSegmentBytes * 2) throw Error('Invalid live buffer limits');
  const channels = new Map<string, Channel>();
  let stopped = false;
  // Include a boot epoch and reserve a range per worker lifetime: an old
  // playlist must never resolve a reused segment number to different media.
  let nextSequence = Date.now() * 100 + randomBytes(1)[0];
  let initialized: Promise<void> | undefined;
  const initialize = () => initialized ??= (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // These directories are disposable cache only, never archive or saved media.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('channel-'))
        await rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  })();

  async function retire(ch: Channel) {
    if (ch.terminating) return;
    ch.terminating = true;
    channels.delete(ch.id);
    if (ch.timer) clearInterval(ch.timer);
    const worker = ch.worker;
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    // Child must release file descriptors before deleting its work directory.
    if (worker && worker.exitCode === null) await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1000);
      worker.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    await rm(ch.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function publish(ch: Channel) {
    if (!ch.working || ch.terminating) return;
    let manifest: string;
    try { manifest = await readFile(path.join(ch.working, 'index.m3u8'), 'utf8'); }
    catch { return; }
    const entries = [...manifest.matchAll(/#EXTINF:([\d.]+),?[^\n]*\n([^\r\n]+\.ts)/g)];
    for (const [, durationText, name] of entries) {
      if (!/^\d+\.ts$/.test(name) || ch.terminating) continue;
      const key = `${ch.generation}-${name}`;
      if (ch.segments.some(s => s.name === key)) continue;
      const duration = Number(durationText);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      // A longer GOP cannot satisfy this live playlist's fixed reload cadence.
      // Stop the worker rather than hiding a unique segment or lying about TARGETDURATION.
      if (duration > 4) { void retire(ch); return; }
      let data: Buffer;
      try { data = await readFile(path.join(ch.working, name)); } catch { continue; }
      if (!data.length || data.length > maxSegmentBytes || ch.terminating) continue;
      try {
        const space = await statfs(root);
        if (space.bavail * space.bsize < minFreeBytes + data.length) { void retire(ch); return; }
      } catch { void retire(ch); return; }
      const id = ch.sequence++;
      const filename = `${id}.ts`;
      try { await writeFile(path.join(ch.dir, filename), data, { flag: 'wx' }); }
      catch { void retire(ch); return; }
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
    const working = await mkdtemp(path.join(ch.dir, 'ingest-'));
    if (ch.terminating || stopped) { await rm(working, { recursive: true, force: true }); return; }
    ch.working = working;
    ch.lastPublish = Date.now();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', url,
      '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'hls',
      '-hls_time', String(segmentSeconds), '-hls_list_size', '4',
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
    if (ch) { ch.lastAccess = Date.now(); return ch; }
    if (stopped || channels.size >= maxChannels) return null;
    ch = { id, dir: '', segments: [], bytes: 0, sequence: nextSequence, discontinuitySequence: 0,
      generation: 0, lastAccess: Date.now(), lastPublish: Date.now(), terminating: false };
    nextSequence += 100_000_000;
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
    async playlist(id: string, url: string, ticket?: string) {
      const ch = await get(id, url);
      if (!ch || !ch.segments.length) return null;
      const rows = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
        `#EXT-X-MEDIA-SEQUENCE:${ch.segments[0].id}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${ch.discontinuitySequence}`];
      for (const seg of ch.segments) {
        if (seg.discontinuity) rows.push('#EXT-X-DISCONTINUITY');
        rows.push(`#EXTINF:${seg.duration.toFixed(3)},`, `segment/${seg.id}.ts${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`);
      }
      return `${rows.join('\n')}\n`;
    },
    async segment(id: string, segmentId: number) {
      const ch = channels.get(id);
      if (!ch) return null;
      ch.lastAccess = Date.now();
      const seg = ch.segments.find(s => s.id === segmentId);
      if (!seg) return null;
      try { return await readFile(path.join(ch.dir, `${seg.id}.ts`)); } catch { return null; }
    },
    async stop() { stopped = true; await Promise.all([...channels.values()].map(retire)); },
  };
}

export function createLiveRouter(buffer: ReturnType<typeof createLiveBuffer>, source: (id: string) => string | null | undefined) {
  const router = Router();
  const secret = randomBytes(32);
  const ttl = 24 * 60 * 60_000;
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
    if (!allowed(req, id)) { res.status(401).end(); return; }
    const url = source(id);
    if (!url) { res.status(404).end(); return; }
    if (req.query.audio === '1') { res.status(422).end(); return; }
    // Native players may not retry an initial 503 playlist. Wait briefly for
    // a published segment; otherwise let the caller use its legacy TS path.
    const deadline = Date.now() + 5_000;
    let ready = false;
    do {
      const manifest = await buffer.playlist(id, url);
      if (manifest?.includes('\nsegment/')) { ready = true; break; }
      if (Date.now() >= deadline || req.destroyed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
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
    const bytes = await buffer.segment(id, Number(rawId));
    if (!bytes) { res.status(404).end(); return; }
    res.type('video/mp2t').send(bytes);
  });
  return router;
}

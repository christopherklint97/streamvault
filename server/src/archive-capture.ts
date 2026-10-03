import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { processArchiveSeam } from './archive-seam.js';
import { pairEnabledFor, processArchivePair } from './archive-pair-worker.js';
import type { ArchiveStore } from './archive-store.js';

const GIB = 1024 * 1024 * 1024;
const RESERVE_BYTES = 20 * GIB;
const MAX_ARCHIVE_BYTES = 400 * GIB;
// A live ESPN HLS writer should commit a segment about every twenty seconds.
// A stalled proxy connection can leave FFmpeg alive indefinitely without output.
const WRITER_STALE_MS = 120_000;
const WRITER_KILL_GRACE_MS = 5_000;
type ArchiveWriter = {
  process: ChildProcess;
  timer: ReturnType<typeof setInterval>;
  directory: string;
  epoch: number;
  startedAt: number;
  lastPublishedAt: number;
  proxyEndAt?: number;
  terminationRequested?: boolean;
  intentionalStop?: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  stale?: boolean;
  capacityError?: string;
};
export function hasArchiveReserve(freeBytes: number, reserveBytes = RESERVE_BYTES): boolean {
  return Number.isFinite(freeBytes) && freeBytes > reserveBytes;
}
export function hasArchiveCapacity(freeBytes: number, usedBytes: number, reserveBytes = RESERVE_BYTES,
  maxBytes = MAX_ARCHIVE_BYTES): boolean {
  return hasArchiveReserve(freeBytes, reserveBytes) && Number.isFinite(usedBytes) && usedBytes < maxBytes;
}
/** Background copies must leave space for raw capture between pruning passes. */
export function hasArchiveRepairHeadroom(freeBytes: number, usedBytes: number,
  reserveBytes: number, maxBytes: number): boolean {
  return Number.isFinite(freeBytes) && Number.isFinite(usedBytes) &&
    freeBytes > reserveBytes + Math.min(5 * GIB, reserveBytes / 4) &&
    usedBytes < maxBytes - Math.min(10 * GIB, maxBytes / 20);
}
function gigabytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : fallback;
}
export function nextArchiveEpoch(current: number, discontinuity: boolean): number {
  return current + (discontinuity ? 1 : 0);
}

export function hlsCaptureArgs(url: string, directory: string, authToken?: string, captureSession?: string): string[] {
  const headers = [authToken ? `Authorization: Bearer ${authToken}` : null,
    captureSession && /^[0-9a-f-]{36}$/.test(captureSession)
      ? `X-StreamVault-Capture-Session: ${captureSession}` : null].filter(Boolean).join('\r\n');
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin',
    ...(headers ? ['-headers', `${headers}\r\n`] : []), '-i', url,
    '-map', '0:v:0?', '-map', '0:a?', '-map', '0:d?', '-c', 'copy', '-copy_unknown',
    '-f', 'hls', '-hls_time', '20', '-hls_list_size', '12',
    '-hls_flags', 'temp_file+program_date_time+omit_endlist+independent_segments',
    '-hls_segment_type', 'mpegts', '-hls_segment_filename', path.join(directory, 'chunk-%09d.ts'),
    path.join(directory, 'current.m3u8')];
}

export function archiveRetryDelay(options: {
  channelId: string; allowlist?: string; code: number | null; signal: string | null;
  sessionMs: number; publishAgeMs: number; proxyEndAgeMs?: number; hasPublished: boolean;
  fastAttemptsLast10Min: number; stalled: boolean; storageLow: boolean;
}): number {
  if (options.storageLow) return 60_000;
  const eligible = options.code === 0 && !options.signal && !options.stalled && options.hasPublished &&
    options.allowlist?.split(',').some(id => id.trim() === options.channelId) &&
    options.sessionMs >= 30_000 && options.publishAgeMs >= 0 && options.publishAgeMs <= 30_000 &&
    options.proxyEndAgeMs !== undefined && options.proxyEndAgeMs >= 0 && options.proxyEndAgeMs <= 5_000 &&
    options.fastAttemptsLast10Min >= 0 && options.fastAttemptsLast10Min < 4;
  return eligible ? 1_000 : 10_000;
}

export function parsePublishedSegments(manifest: string) {
  const entries: Array<{ name: string; start?: number; duration: number; discontinuity: boolean }> = [];
  let start: number | undefined;
  let duration: number | undefined;
  let discontinuity = false;
  for (const line of manifest.split(/\r?\n/)) {
    if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) start = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith('#')) {
      if (/^chunk-\d{9}\.ts$/.test(line) && Number.isFinite(duration) && duration! > 0) {
        entries.push({ name: line, ...(Number.isFinite(start) ? { start } : {}), duration: duration!, discontinuity });
      }
      start = undefined; duration = undefined; discontinuity = false;
    }
  }
  return entries;
}

/** A writer is unique per channel. FFmpeg atomically renames .tmp files and
 * playlists. Rollover recovery probes only older, finalized unlisted files. */
export class ArchiveCapture {
  private readonly writers = new Map<string, ArchiveWriter>();
  private readonly fastRetryHistory = new Map<string, number[]>();
  private retry = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;
  private seamQueue: string[] = [];
  private seamQueued = new Set<string>();
  private seamPairChannels = new Map<string, string>();
  private seamUrgent = new Set<string>();
  private seamTimer: ReturnType<typeof setTimeout> | null = null;
  private seamWork: Promise<void> | null = null;
  private seamWorkAbort: AbortController | null = null;
  private seamWorkChannel: string | null = null;
  private readonly seamAbort = new AbortController();
  constructor(private readonly store: ArchiveStore, private readonly root: string, private readonly port: number,
    private readonly onPublished: (channelId: string) => void = () => {},
    private readonly spawnWriter: typeof spawn = spawn,
    private readonly processSeam: typeof processArchiveSeam = processArchiveSeam,
    private readonly processPair: typeof processArchivePair = processArchivePair) {}
  private pairCanRun(channelId: string): boolean {
    return pairEnabledFor(channelId, process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK,
      process.env.STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS);
  }
  /** Correlate a loopback capture's completed response with its active writer. */
  noteProxyLifecycle(channelId: string, session: string, cause: string, responseFinished: boolean): void {
    if (cause !== 'upstream_end' || !responseFinished) return;
    const writer = this.writers.get(channelId);
    if (writer && path.basename(writer.directory) === session) writer.proxyEndAt = Date.now();
  }

  /** Keep FFprobe/stream-copy work off the synchronous two-second capture poll.
   * New archive segments jump ahead of historical backfill; one job runs at a time. */
  private enqueueSeam(id: string, urgent = false): void {
    if (this.stopping || !id.endsWith('-chunk-000000000.ts')) return;
    const rawMode = process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1';
    const channel = rawMode ? this.store.getChunk(id)?.channelId : undefined;
    if (rawMode && !this.pairCanRun(channel ?? '')) return;
    if (this.seamQueued.has(id)) {
      if (!urgent || this.seamUrgent.has(id)) return;
      const index = this.seamQueue.indexOf(id);
      if (index < 0) return; // Already processing; never run two repairs for the same seam.
      this.seamQueue.splice(index, 1);
    } else if (this.seamQueue.length >= 2_000) {
      if (!urgent) return;
      const dropped = this.seamQueue.pop();
      if (dropped) { this.seamQueued.delete(dropped); this.seamUrgent.delete(dropped);
        this.seamPairChannels.delete(dropped); }
    }
    this.seamQueued.add(id);
    if (channel) this.seamPairChannels.set(id, channel);
    if (urgent) {
      this.seamUrgent.add(id);
      this.seamQueue.unshift(id);
      // Do not make an active viewer wait through the historical backfill delay.
      if (this.seamTimer) { clearTimeout(this.seamTimer); this.seamTimer = null; }
    }
    else this.seamQueue.push(id);
    this.scheduleSeam();
  }

  /** New playback tickets can lift an existing historical seam ahead of backfill.
   * The ticket's pinned media is unchanged; reopening later selects repaired copies. */
  prioritizeWindow(channelId: string, start: number, end: number): void {
    if (this.stopping || (process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1' &&
        !this.pairCanRun(channelId)) || !this.store.getArchive(channelId)?.enabled || end <= start) return;
    const candidates = (process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1'
      ? this.store.pairCandidates(channelId, start)
      : this.store.seamCandidates(channelId, start))
      .filter(chunk => chunk.start < end).slice(0, 200);
    for (const chunk of candidates.reverse()) this.enqueueSeam(chunk.id, true);
  }

  private scheduleSeam(delay = 0): void {
    if (this.stopping || this.seamWork || this.seamTimer || !this.seamQueue.length) return;
    this.seamTimer = setTimeout(() => {
      this.seamTimer = null;
      if (this.stopping) return;
      if (process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1' &&
          (!process.env.STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS?.trim() ||
            !this.seamQueue.some(id => this.pairCanRun(this.seamPairChannels.get(id) ?? '')))) {
        this.seamQueue = [];
        this.seamQueued.clear();
        this.seamUrgent.clear();
        this.seamPairChannels.clear();
        return;
      }
      const reserve = gigabytes(process.env.STREAMVAULT_ARCHIVE_RESERVE_GB, 20) * GIB;
      const maximum = gigabytes(process.env.STREAMVAULT_ARCHIVE_MAX_DISK_GB, 400) * GIB;
      try {
        const disk = fs.statfsSync(this.root);
        if (!hasArchiveRepairHeadroom(disk.bavail * disk.bsize, this.store.totalUsageBytes(), reserve, maximum)) {
          this.scheduleSeam(60_000); return;
        }
      } catch { this.scheduleSeam(60_000); return; }
      const id = this.seamQueue.shift();
      if (!id) return;
      const chunk = this.store.getChunk(id);
      if (!chunk || !this.store.getArchive(chunk.channelId)?.enabled ||
          (process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1' &&
            (!this.seamPairChannels.has(id) || !this.pairCanRun(chunk.channelId)))) {
        this.seamQueued.delete(id);
        this.seamUrgent.delete(id);
        this.seamPairChannels.delete(id);
        this.scheduleSeam(); return;
      }
      const controller = new AbortController();
      this.seamWorkAbort = controller;
      this.seamWorkChannel = chunk.channelId;
      const signal = AbortSignal.any([this.seamAbort.signal, controller.signal]);
      const processor = process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1' ? this.processPair : this.processSeam;
      const work = processor(this.store, this.root, id, Date.now(), reserve, maximum, signal)
        .then(() => {}, () => {
          if (!this.stopping) logger.warn('Archive seam check failed; captured media preserved');
        })
        .finally(() => {
          this.seamQueued.delete(id);
          this.seamUrgent.delete(id);
          this.seamPairChannels.delete(id);
          if (this.seamWork === work) {
            this.seamWork = null;
            this.seamWorkAbort = null;
            this.seamWorkChannel = null;
          }
          this.scheduleSeam(this.seamUrgent.has(this.seamQueue[0]) ? 0 : 10_000);
        });
      this.seamWork = work;
    }, delay);
    this.seamTimer.unref();
  }

  private capacityError(): string | null {
    const reserve = gigabytes(process.env.STREAMVAULT_ARCHIVE_RESERVE_GB, 20);
    const maximum = gigabytes(process.env.STREAMVAULT_ARCHIVE_MAX_DISK_GB, 400);
    try {
      const stats = fs.statfsSync(this.root);
      if (!hasArchiveReserve(stats.bavail * stats.bsize, reserve * GIB)) return `Less than ${reserve} GiB free; archive capture paused`;
      if (this.store.totalUsageBytes() >= maximum * GIB) return `Archive media reached ${maximum} GiB cap; capture paused`;
      return null;
    } catch { return 'Archive storage unavailable; capture paused'; }
  }

  private showChannels = new Set<string>();
  start(channelId: string, forShow = false): void {
    if (forShow) this.showChannels.add(channelId);
    if (this.stopping || this.writers.has(channelId) || this.retry.has(channelId) ||
      (!this.store.getArchive(channelId)?.enabled && !this.showChannels.has(channelId))) return;
    fs.mkdirSync(this.root, { recursive: true });
    const capacityError = this.capacityError();
    if (capacityError) {
      this.store.setStatus(channelId, 'storage_low', capacityError);
      const timer = setTimeout(() => { this.retry.delete(channelId); this.start(channelId); }, 60_000);
      this.retry.set(channelId, timer);
      return;
    }
    const session = randomUUID();
    const directory = path.join(this.root, 'archive', encodeURIComponent(channelId), session);
    fs.mkdirSync(directory, { recursive: true });
    const url = `http://127.0.0.1:${this.port}/api/stream/${encodeURIComponent(channelId)}?subs=1`;
    const proc = this.spawnWriter('ffmpeg', hlsCaptureArgs(url, directory, process.env.STREAMVAULT_AUTH_TOKEN, session), { stdio: ['ignore', 'ignore', 'pipe'] });
    const writer: ArchiveWriter = { process: proc, directory, epoch: Date.now(), startedAt: Date.now(),
      lastPublishedAt: Date.now(), timer: setInterval(() => this.poll(channelId), 2_000) };
    this.writers.set(channelId, writer);
    // FFmpeg diagnostics may contain credential-bearing provider URLs. Never
    // persist or log raw stderr (or a raw spawn exception).
    proc.stderr?.on('data', () => {});
    proc.once('error', () => { logger.warn(`Archive ${channelId}: writer spawn failed`); });
    proc.once('close', (code, signal) => {
      if (writer.forceKillTimer) clearTimeout(writer.forceKillTimer);
      this.poll(channelId);
      clearInterval(writer.timer);
      if (this.writers.get(channelId) !== writer) return;
      this.writers.delete(channelId);
      const exitCause = this.stopping || writer.intentionalStop ? 'intentional' :
        writer.capacityError ? 'storage_low' : writer.stale ? 'stalled' : 'source_exit';
      const safeId = /^[a-zA-Z0-9_-]{1,64}$/.test(channelId) ? channelId : 'unknown';
      logger.info(`Archive writer lifecycle ${safeId}: cause=${exitCause} code=${typeof code === 'number' ? code : 'null'}` +
        ` signal=${signal && /^SIG[A-Z0-9]+$/.test(signal) ? signal : 'none'}` +
        ` sessionMs=${Date.now() - writer.startedAt} publishAgeMs=${Date.now() - writer.lastPublishedAt}`);
      if (this.stopping || writer.intentionalStop ||
        (!this.store.getArchive(channelId)?.enabled && !this.showChannels.has(channelId))) return;
      const restartReason = writer.capacityError ? 'storage_low' : writer.stale ? 'stalled' : 'source_exit';
      this.store.noteAutoRestart(channelId, restartReason, Date.now());
      const reason = writer.capacityError ?? (writer.stale ? 'No archive segment published for two minutes' :
        'Source disconnected');
      this.store.setStatus(channelId, writer.capacityError ? 'storage_low' : 'retrying', reason);
      // An opt-in clean, recently publishing writer exit can skip most of the
      // cooldown. The replacement still uses a fresh session so its first
      // chunk remains an explicit discontinuity and seam-repair candidate.
      const now = Date.now();
      const recentFastRetries = (this.fastRetryHistory.get(channelId) ?? [])
        .filter(at => at <= now && now - at < 10 * 60_000);
      const delay = archiveRetryDelay({ channelId,
        allowlist: process.env.STREAMVAULT_FAST_EOF_CHANNEL_IDS, code, signal,
        sessionMs: now - writer.startedAt, publishAgeMs: now - writer.lastPublishedAt,
        proxyEndAgeMs: writer.proxyEndAt === undefined ? undefined : now - writer.proxyEndAt,
        hasPublished: Boolean(this.store.cursor(path.basename(writer.directory))),
        fastAttemptsLast10Min: recentFastRetries.length,
        stalled: Boolean(writer.stale), storageLow: Boolean(writer.capacityError) });
      if (delay === 1_000) recentFastRetries.push(now);
      if (recentFastRetries.length) this.fastRetryHistory.set(channelId, recentFastRetries);
      else this.fastRetryHistory.delete(channelId);
      logger.info(`Archive retry ${safeId}: delayMs=${delay} cause=${restartReason}`);
      const timer = setTimeout(() => { this.retry.delete(channelId); this.start(channelId); }, delay);
      this.retry.set(channelId, timer);
    });
  }

  private poll(channelId: string): void {
    const writer = this.writers.get(channelId);
    if (!writer) return;
    this.importSession(channelId, writer.directory, writer);
    const capacityError = this.capacityError();
    if (capacityError) {
      writer.capacityError = capacityError;
      this.store.setStatus(channelId, 'storage_low', capacityError);
      this.terminateWriter(channelId, writer);
      return;
    }
    if (!writer.terminationRequested && Date.now() - writer.lastPublishedAt >= WRITER_STALE_MS) {
      writer.stale = true;
      this.store.setStatus(channelId, 'retrying', 'No archive segment published for two minutes');
      logger.warn(`Archive ${channelId}: writer stopped publishing; reconnecting`);
      this.terminateWriter(channelId, writer);
    }
  }

  private terminateWriter(channelId: string, writer: ArchiveWriter): void {
    if (writer.terminationRequested) return;
    writer.terminationRequested = true;
    writer.process.kill('SIGINT');
    writer.forceKillTimer = setTimeout(() => {
      if (this.writers.get(channelId) === writer) writer.process.kill('SIGKILL');
    }, WRITER_KILL_GRACE_MS);
    writer.forceKillTimer.unref();
  }

  /** Reconcile the durable index first; then recover finalized TS files older than
   * the sliding manifest. Never trust a newest unlisted segment or a .tmp. */
  recover(): void {
    this.store.clearExpired(Date.now());
    for (const chunk of this.store.indexedChunks()) {
      const validFile = (relative: string): boolean => {
        try {
          const file = path.resolve(this.root, relative);
          return file.startsWith(path.resolve(this.root) + path.sep) && relative.endsWith('.ts') &&
            fs.realpathSync(file).startsWith(fs.realpathSync(this.root) + path.sep) &&
            fs.statSync(file).isFile() && fs.statSync(file).size > 0;
        } catch { return false; }
      };
      const rawValid = validFile(chunk.path);
      const playbackValid = !chunk.playbackPath || validFile(chunk.playbackPath);
      if (!rawValid || !playbackValid) {
        const result = rawValid
          ? chunk.pairId && this.store.restorePlaybackChainRaw(chunk.id, validFile)
            ? 'restored_raw_pair' : this.store.reconcilePlaybackMissing(chunk.id)
          : this.store.reconcileMissing(chunk.id);
        logger.warn(`Archive ${chunk.channelId}: missing indexed segment ${chunk.id} (${result})`);
      } else if (chunk.unavailable) this.store.markAvailable(chunk.id);
    }
    const base = path.join(this.root, 'archive');
    const releaseDetached = () => {
      const root = fs.realpathSync(this.root);
      for (const detached of this.store.detachedPlayback()) {
        const absolute = path.resolve(root, detached.path);
        if (!absolute.startsWith(root + path.sep) || !detached.path.endsWith('.playback.ts')) continue;
        try {
          let exists = false;
          try { fs.lstatSync(absolute); exists = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (exists) {
            const parent = fs.realpathSync(path.dirname(absolute));
            if (!parent.startsWith(root + path.sep)) continue;
            fs.unlinkSync(absolute);
          }
          try { fs.lstatSync(absolute); throw new Error('Detached file remains'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          this.store.releaseDetachedPlayback(detached.path);
        } catch { logger.warn('Archive detached presentation cleanup deferred'); }
      }
    };
    if (!fs.existsSync(base)) { releaseDetached(); return; }
    for (const channelDir of fs.readdirSync(base, { withFileTypes: true })) {
      if (!channelDir.isDirectory()) continue;
      let channelId: string;
      try { channelId = decodeURIComponent(channelDir.name); } catch { continue; }
      if (!this.store.getArchive(channelId) || encodeURIComponent(channelId) !== channelDir.name) continue;
      for (const session of fs.readdirSync(path.join(base, channelDir.name), { withFileTypes: true })) {
        if (!session.isDirectory() || !/^[0-9a-f-]{36}$/.test(session.name)) continue;
        const directory = path.join(base, channelDir.name, session.name);
        if (this.writers.get(channelId)?.directory === directory) continue;
        const admitted = this.importSession(channelId, directory, undefined, true);
        for (const name of fs.readdirSync(directory)) {
          const playbackMaster = /^chunk-(\d{9})(?:\.[0-9a-f-]{36}\.pair)?\.playback\.ts$/.exec(name);
          // Interrupted pair remuxes use .part.ts rather than the older .part
          // suffix. Only known pair-stage names in INACTIVE sessions are safe
          // to remove; never infer a master from a generic .ts suffix.
          const playbackStage = /^chunk-\d{9}\.[0-9a-f-]{36}\.pair\.playback\.ts(?:\.(?:prior-video|prior-audio|video|audio|joined))?\.part\.ts$/.test(name);
          const indexedPlayback = playbackMaster && this.store.getChunk(
            `${session.name}-chunk-${playbackMaster[1]}.ts`)?.playbackPath ===
            path.relative(this.root, path.join(directory, name));
          if (((/^chunk-\d{9}\.ts(?:\.tmp)?$/.test(name) && !admitted.has(name) &&
            !this.store.getChunk(`${session.name}-${name}`)) || name.endsWith('.part') || playbackStage ||
            (playbackMaster && !indexedPlayback && !this.store.isDetachedPlayback(
              path.relative(this.root, path.join(directory, name))))) &&
            !fs.lstatSync(path.join(directory, name)).isSymbolicLink()) {
            try { fs.unlinkSync(path.join(directory, name)); } catch (error) {
              logger.warn(`Archive recovery could not clean ${channelId}/${session.name}/${name}: ${error}`);
            }
          }
        }
      }
    }
    releaseDetached();
  }

  private importSession(channelId: string, directory: string, writer?: ArchiveWriter, recovering = false): Set<string> {
    const admitted = new Set<string>();
    let manifest: string;
    try { manifest = fs.readFileSync(path.join(directory, 'current.m3u8'), 'utf8'); } catch { return admitted; }
    const session = path.basename(directory);
    const entries = parsePublishedSegments(manifest);
    const firstSequence = entries.length ? Number(entries[0].name.slice(6, 15)) : 0;
    const cursor = this.store.cursor(session);
    // This scan is only needed at startup or after a polling delay exceeds the
    // sliding window. The ordinary two-second poll touches only twelve entries.
    if (firstSequence > 0 && (recovering || !cursor || firstSequence > cursor.sequence + 1)) {
      for (const name of fs.readdirSync(directory).filter(n => /^chunk-\d{9}\.ts$/.test(n) &&
        Number(n.slice(6, 15)) < firstSequence).sort()) {
        const id = `${session}-${name}`;
        if (this.store.getChunk(id)) { admitted.add(name); continue; }
        const absolute = path.join(directory, name);
        try {
          // A completed TS omitted by rollover must be independently probeable;
          // its mtime supplies wall time. An unlisted newest file is not committed.
          const output = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', absolute], { timeout: 15_000 }).toString();
          const duration = Number(output.trim());
          if (!Number.isFinite(duration) || duration <= 0) continue;
          this.publishFile(channelId, directory, name, duration, false, writer);
          admitted.add(name);
        } catch (error) { logger.warn(`Archive ${channelId}: cannot recover ${name}: ${error}`); }
      }
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(absolute); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      admitted.add(entry.name);
      if (this.store.getChunk(`${session}-${entry.name}`)) continue;
      try {
        this.publishFile(channelId, directory, entry.name, entry.duration, entry.discontinuity, writer);
      } catch (error) { logger.warn(`Archive ${channelId} publication failed: ${error}`); }
    }
    return admitted;
  }

  private publishFile(channelId: string, directory: string, name: string, duration: number,
    discontinuity: boolean, writer?: ArchiveWriter): void {
    const absolute = path.join(directory, name);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size <= 0) return;
    const session = path.basename(directory);
    const previous = this.store.cursor(session);
    // FFmpeg PDT is a media clock; after a source stall it may advance by only
    // twenty seconds while an hour elapsed. Segment mtime reflects observed
    // output. Do not assign missing wall-clock coverage to stalled media.
    const end = Math.min(Date.now(), Math.round(stat.mtimeMs));
    const length = Math.round(duration * 1000);
    const start = end - length;
    const gap = previous && start > previous.end + 5_000;
    const epoch = nextArchiveEpoch(previous?.epoch ?? writer?.epoch ?? 0, discontinuity || Boolean(gap));
    const id = `${session}-${name}`;
    this.store.publish({ id, channelId, start, end, duration,
      path: path.relative(this.root, absolute), size: stat.size, epoch });
    if (this.store.getArchive(channelId)?.enabled && name === 'chunk-000000000.ts') {
      this.enqueueSeam(id, true);
      // The previous session's first chunk was initially queued while that
      // session was still open. Its finite timeline becomes provable only
      // after this new session publishes its first chunk.
      if (this.pairCanRun(channelId)) {
        const previousChunk = this.store.previousChunk(id);
        const previousSession = previousChunk?.id.split('-chunk-')[0];
        if (previousSession && previousSession !== session) {
          const first = this.store.getChunk(`${previousSession}-chunk-000000000.ts`);
          if (first && !first.pairId && !first.unavailable && first.channelId === channelId)
            this.enqueueSeam(first.id, true);
        }
      }
    }
    if (writer) {
      writer.epoch = epoch;
      writer.lastPublishedAt = Date.now();
      if (!writer.intentionalStop) this.store.noteRecovery(channelId, writer.lastPublishedAt);
    }
    this.onPublished(channelId);
  }

  async stop(channelId: string): Promise<void> {
    const retry = this.retry.get(channelId);
    if (retry) { clearTimeout(retry); this.retry.delete(channelId); }
    const writer = this.writers.get(channelId);
    if (!writer) return;
    writer.intentionalStop = true;
    writer.terminationRequested = true;
    await new Promise<void>(resolve => {
      writer.process.once('close', () => resolve());
      writer.process.kill('SIGINT');
      setTimeout(() => writer.process.kill('SIGKILL'), 5_000).unref();
    });
    this.store.setStatus(channelId, 'stopped');
  }
  async stopArchive(channelId: string): Promise<void> {
    if (this.seamWorkChannel === channelId) {
      this.seamWorkAbort?.abort();
      if (this.seamWork) await this.seamWork;
    }
    if (!this.showChannels.has(channelId)) await this.stop(channelId);
    this.seamQueue = this.seamQueue.filter(id => {
      if (this.store.getChunk(id)?.channelId !== channelId) return true;
      this.seamQueued.delete(id);
      this.seamUrgent.delete(id);
      this.seamPairChannels.delete(id);
      return false;
    });
    if (!this.seamQueue.length && this.seamTimer) {
      clearTimeout(this.seamTimer); this.seamTimer = null;
    }
  }
  async stopShow(channelId: string): Promise<void> {
    this.showChannels.delete(channelId);
    if (!this.store.getArchive(channelId)?.enabled) await this.stop(channelId);
  }
  startAll(): void {
    for (const archive of this.store.archives()) if (archive.enabled) this.start(archive.channelId);
    // Backfill every configured channel while prioritizing newly captured seams.
    // Derived copies never overwrite the masters or an existing snapshot pin.
    const now = Date.now();
    const candidates = this.store.archives().filter(archive => archive.enabled &&
      (process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK !== '1' || this.pairCanRun(archive.channelId)))
      .flatMap(archive => process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1'
        ? this.store.pairCandidates(archive.channelId, now - archive.retentionHours * 3_600_000)
        : this.store.seamCandidates(archive.channelId, now - archive.retentionHours * 3_600_000));
    const windows = this.store.recentViewerWindows(now, 60 * 60_000);
    const focused = new Set(candidates.filter(chunk => windows.some(w => w.channelId === chunk.channelId &&
      chunk.end > w.startTime && chunk.start < w.endTime)).map(chunk => chunk.id));
    candidates.sort((a, b) => Number(focused.has(b.id)) - Number(focused.has(a.id)) || b.end - a.end);
    for (const chunk of candidates) this.enqueueSeam(chunk.id);
  }
  async stopAll(): Promise<void> {
    this.stopping = true;
    this.seamAbort.abort();
    this.seamWorkAbort?.abort();
    if (this.seamTimer) clearTimeout(this.seamTimer);
    this.seamTimer = null;
    this.seamQueue = [];
    this.seamQueued.clear();
    this.seamUrgent.clear();
    this.seamPairChannels.clear();
    const channels = new Set([...this.writers.keys(), ...this.retry.keys()]);
    await Promise.all([...channels].map(id => this.stop(id)));
    // Wait for the abortable child and its staged-file cleanup before the
    // caller closes SQLite. The process-wide shutdown deadline remains armed.
    if (this.seamWork) await this.seamWork;
  }
}

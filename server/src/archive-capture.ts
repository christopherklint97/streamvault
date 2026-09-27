import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import type { ArchiveStore } from './archive-store.js';

const GIB = 1024 * 1024 * 1024;
const RESERVE_BYTES = 20 * GIB;
const MAX_ARCHIVE_BYTES = 400 * GIB;
export function hasArchiveReserve(freeBytes: number, reserveBytes = RESERVE_BYTES): boolean {
  return Number.isFinite(freeBytes) && freeBytes > reserveBytes;
}
export function hasArchiveCapacity(freeBytes: number, usedBytes: number, reserveBytes = RESERVE_BYTES,
  maxBytes = MAX_ARCHIVE_BYTES): boolean {
  return hasArchiveReserve(freeBytes, reserveBytes) && Number.isFinite(usedBytes) && usedBytes < maxBytes;
}
function gigabytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : fallback;
}
export function nextArchiveEpoch(current: number, discontinuity: boolean): number {
  return current + (discontinuity ? 1 : 0);
}

export function hlsCaptureArgs(url: string, directory: string, authToken?: string): string[] {
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin',
    ...(authToken ? ['-headers', `Authorization: Bearer ${authToken}\r\n`] : []), '-i', url,
    '-map', '0:v:0?', '-map', '0:a?', '-map', '0:d?', '-c', 'copy', '-copy_unknown',
    '-f', 'hls', '-hls_time', '20', '-hls_list_size', '12',
    '-hls_flags', 'temp_file+program_date_time+omit_endlist+independent_segments',
    '-hls_segment_type', 'mpegts', '-hls_segment_filename', path.join(directory, 'chunk-%09d.ts'),
    path.join(directory, 'current.m3u8')];
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
  private readonly writers = new Map<string, { process: ChildProcess; timer: ReturnType<typeof setInterval>; directory: string; epoch: number }>();
  private retry = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;
  constructor(private readonly store: ArchiveStore, private readonly root: string, private readonly port: number,
    private readonly onPublished: (channelId: string) => void = () => {}) {}

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
    const proc = spawn('ffmpeg', hlsCaptureArgs(url, directory, process.env.STREAMVAULT_AUTH_TOKEN), { stdio: ['ignore', 'ignore', 'pipe'] });
    const writer = { process: proc, directory, epoch: Date.now(), timer: setInterval(() => this.poll(channelId), 2_000) };
    this.writers.set(channelId, writer);
    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => { stderr = (stderr + String(data)).slice(-2048); });
    proc.once('error', error => { logger.warn(`Archive ${channelId} spawn: ${error.message}`); });
    proc.once('close', () => {
      this.poll(channelId);
      clearInterval(writer.timer);
      if (this.writers.get(channelId) !== writer) return;
      this.writers.delete(channelId);
      if (this.stopping || (!this.store.getArchive(channelId)?.enabled && !this.showChannels.has(channelId))) return;
      this.store.setStatus(channelId, 'retrying', stderr.replaceAll(process.env.STREAMVAULT_AUTH_TOKEN || '\0', '[redacted]').slice(-500) || 'Source disconnected');
      const timer = setTimeout(() => { this.retry.delete(channelId); this.start(channelId); }, 10_000);
      this.retry.set(channelId, timer);
    });
  }

  private poll(channelId: string): void {
    const writer = this.writers.get(channelId);
    if (!writer) return;
    const capacityError = this.capacityError();
    if (capacityError) {
      this.store.setStatus(channelId, 'storage_low', capacityError);
      writer.process.kill('SIGINT');
    }
    this.importSession(channelId, writer.directory, writer);
  }

  /** Reconcile the durable index first; then recover finalized TS files older than
   * the sliding manifest. Never trust a newest unlisted segment or a .tmp. */
  recover(): void {
    this.store.clearExpired(Date.now());
    for (const chunk of this.store.indexedChunks()) {
      const absolute = path.resolve(this.root, chunk.path);
      let valid = false;
      try {
        valid = absolute.startsWith(path.resolve(this.root) + path.sep) && chunk.path.endsWith('.ts') &&
          fs.realpathSync(absolute).startsWith(fs.realpathSync(this.root) + path.sep) &&
          fs.statSync(absolute).isFile() && fs.statSync(absolute).size > 0;
      } catch { /* absent or unsafe */ }
      if (!valid) {
        const result = this.store.reconcileMissing(chunk.id);
        logger.warn(`Archive ${chunk.channelId}: missing indexed segment ${chunk.id} (${result})`);
      } else if (chunk.unavailable) this.store.markAvailable(chunk.id);
    }
    const base = path.join(this.root, 'archive');
    if (!fs.existsSync(base)) return;
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
          if (((/^chunk-\d{9}\.ts(?:\.tmp)?$/.test(name) && !admitted.has(name) &&
            !this.store.getChunk(`${session.name}-${name}`)) || name.endsWith('.part')) && !fs.lstatSync(path.join(directory, name)).isSymbolicLink()) {
            try { fs.unlinkSync(path.join(directory, name)); } catch (error) {
              logger.warn(`Archive recovery could not clean ${channelId}/${session.name}/${name}: ${error}`);
            }
          }
        }
      }
    }
  }

  private importSession(channelId: string, directory: string, writer?: { epoch: number }, recovering = false): Set<string> {
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
    discontinuity: boolean, writer?: { epoch: number }): void {
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
    this.store.publish({ id: `${session}-${name}`, channelId, start, end, duration,
      path: path.relative(this.root, absolute), size: stat.size, epoch });
    if (writer) writer.epoch = epoch;
    this.onPublished(channelId);
  }

  async stop(channelId: string): Promise<void> {
    const retry = this.retry.get(channelId);
    if (retry) { clearTimeout(retry); this.retry.delete(channelId); }
    const writer = this.writers.get(channelId);
    if (!writer) return;
    await new Promise<void>(resolve => {
      writer.process.once('close', () => resolve());
      writer.process.kill('SIGINT');
      setTimeout(() => writer.process.kill('SIGKILL'), 5_000).unref();
    });
    this.store.setStatus(channelId, 'stopped');
  }
  async stopArchive(channelId: string): Promise<void> {
    if (!this.showChannels.has(channelId)) await this.stop(channelId);
  }
  async stopShow(channelId: string): Promise<void> {
    this.showChannels.delete(channelId);
    if (!this.store.getArchive(channelId)?.enabled) await this.stop(channelId);
  }
  startAll(): void { for (const archive of this.store.archives()) if (archive.enabled) this.start(archive.channelId); }
  async stopAll(): Promise<void> { this.stopping = true; await Promise.all([...this.writers.keys()].map(id => this.stop(id))); }
}

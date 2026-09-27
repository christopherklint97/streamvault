import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess, type ProcessResult, type RunProcessOptions } from './recorder-media.js';

/** The published package is beside the master and is removed with its recording. */
export function vodHlsDirectory(masterPath: string): string {
  return masterPath.replace(/\.ts$/, '.hls');
}

export function buildRecordingVodHlsArgs(masterPath: string, playlistPath: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-fflags', '+genpts+discardcorrupt',
    // Stream-copy faster than playback but bound USB reads/writes while the app is in use.
    '-readrate', '12', '-i', masterPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn',
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
    '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(path.dirname(playlistPath), 'segment-%05d.ts'),
    playlistPath,
  ];
}

/** Never advertise a partial or stale rendition as a finite, seekable movie. */
async function inspectPackage(masterPath: string, directory: string): Promise<'missing' | 'ready'> {
  try {
    const [source, master, manifest, entries] = await Promise.all([
      fs.readFile(path.join(directory, 'source.json'), 'utf8'),
      fs.stat(masterPath),
      fs.readFile(path.join(directory, 'index.m3u8'), 'utf8'),
      fs.readdir(directory),
    ]);
    const fingerprint: unknown = JSON.parse(source);
    if (!fingerprint || typeof fingerprint !== 'object') return 'missing';
    const { size, mtimeMs, durationSeconds } = fingerprint as { size?: unknown; mtimeMs?: unknown; durationSeconds?: unknown };
    if (size !== master.size || mtimeMs !== master.mtimeMs ||
        typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !manifest.startsWith('#EXTM3U') || !manifest.includes('#EXT-X-PLAYLIST-TYPE:VOD') ||
        !manifest.trimEnd().endsWith('#EXT-X-ENDLIST')) return 'missing';
    const durations = [...manifest.matchAll(/^#EXTINF:(\d+(?:\.\d+)?),/gm)].map(match => Number(match[1]));
    const segments = manifest.split('\n').map(line => line.trim()).filter(line => /^segment-\d+\.ts$/.test(line));
    const timeline = durations.reduce((sum, duration) => sum + duration, 0);
    const tolerance = Math.max(2, Math.min(12, durationSeconds * .002));
    if (segments.length === 0 || segments.length > 20_000 || durations.length !== segments.length ||
        durations.some(duration => !Number.isFinite(duration) || duration <= 0) ||
        Math.abs(timeline - durationSeconds) > tolerance) return 'missing';
    const present = new Set(entries);
    return segments.every(segment => present.has(segment)) ? 'ready' : 'missing';
  } catch { return 'missing'; }
}

export function getRecordingVodHlsState(masterPath: string): Promise<'missing' | 'ready'> {
  return inspectPackage(masterPath, vodHlsDirectory(masterPath));
}

export function rewriteRecordingVodPlaylist(manifest: string, recordingId: string, sessionId: string): string {
  const prefix = `/api/recordings/${encodeURIComponent(recordingId)}/vod/`;
  return manifest.replace(/^segment-\d+\.ts$/gm, segment =>
    `${prefix}${segment}?session=${encodeURIComponent(sessionId)}`);
}

type ProcessRunner = (command: string, args: string[], options?: RunProcessOptions) => Promise<ProcessResult>;

/** One background build at a time. A partial package is never advertised. */
export class RecordingVodHlsPreparer {
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private last: Promise<unknown> = Promise.resolve();
  private quotaChecker: (masterPath: string, estimatedBytes: number) => Promise<boolean> = async () => true;

  setQuotaChecker(checker: (masterPath: string, estimatedBytes: number) => Promise<boolean>): void {
    this.quotaChecker = checker;
  }

  constructor(
    private readonly run: ProcessRunner = runProcess,
    private readonly availableBytes: (directory: string) => Promise<number> = async directory => {
      const stat = await fs.statfs(directory);
      return stat.bavail * stat.bsize;
    },
  ) {}

  isPreparing(masterPath: string): boolean { return this.jobs.has(masterPath); }

  ensure(masterPath: string, durationSeconds: number): Promise<void> {
    const existing = this.jobs.get(masterPath);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.last.catch(() => {}).then(() => this.build(masterPath, durationSeconds, controller));
    this.jobs.set(masterPath, { controller, promise });
    this.last = promise.catch(() => {});
    void promise.finally(() => {
      if (this.jobs.get(masterPath)?.promise === promise) this.jobs.delete(masterPath);
    }).catch(() => {});
    return promise;
  }

  async cancel(masterPath: string): Promise<void> {
    const job = this.jobs.get(masterPath);
    if (!job) return;
    job.controller.abort();
    try { await job.promise; } catch { /* deletion proceeds after the writer settles */ }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map(master => this.cancel(master)));
  }

  private async build(masterPath: string, durationSeconds: number, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    if (signal.aborted || await getRecordingVodHlsState(masterPath) === 'ready') return;
    const ready = vodHlsDirectory(masterPath);
    const staging = `${ready}.part-${randomUUID()}`;
    try {
      const before = await fs.stat(masterPath);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Recording duration unavailable');
      const parent = path.dirname(ready);
      const base = path.basename(ready);
      for (const entry of await fs.readdir(parent)) {
        if (entry.startsWith(`${base}.part-`)) await fs.rm(path.join(parent, entry), { recursive: true, force: true });
      }
      const required = Math.ceil(before.size * 1.2) + 1_073_741_824;
      if (await this.availableBytes(parent) < required) throw new Error('Insufficient free space for seekable recording');
      if (!await this.quotaChecker(masterPath, Math.ceil(before.size * 1.2))) {
        throw new Error('Recording storage limit prevents seekable rendition');
      }
      if (signal.aborted) return;
      await fs.mkdir(staging, { recursive: true });
      let ranOutOfSpace = false;
      let checkingSpace = false;
      const spaceTimer = setInterval(() => {
        if (checkingSpace || signal.aborted) return;
        checkingSpace = true;
        void this.availableBytes(parent).then(free => {
          if (free < 536_870_912 && !signal.aborted) { ranOutOfSpace = true; controller.abort(); }
        }).catch(() => { ranOutOfSpace = true; controller.abort(); })
          .finally(() => { checkingSpace = false; });
      }, 5_000);
      let result: ProcessResult;
      try {
        result = await this.run('ffmpeg', buildRecordingVodHlsArgs(masterPath, path.join(staging, 'index.m3u8')), {
          signal, timeoutMs: 90 * 60_000, backgroundPriority: true, outputLimitBytes: 2048,
        });
      } finally { clearInterval(spaceTimer); }
      if (ranOutOfSpace) throw new Error('Insufficient free space while preparing seekable recording');
      if (signal.aborted || result.aborted) return;
      if (result.code !== 0) throw new Error(`Recording VOD HLS failed: ${result.stderr.slice(-512)}`);
      const after = await fs.stat(masterPath);
      if (signal.aborted || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      await fs.writeFile(path.join(staging, 'source.json'), JSON.stringify({ size: before.size, mtimeMs: before.mtimeMs, durationSeconds }));
      if (await inspectPackage(masterPath, staging) !== 'ready' || signal.aborted) {
        throw new Error('Recording VOD HLS output is incomplete');
      }
      await fs.rm(ready, { recursive: true, force: true });
      if (signal.aborted) return;
      await fs.rename(staging, ready);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

export const recordingVodHlsPreparer = new RecordingVodHlsPreparer();

/** Reclaim only abandoned staging directories; leave a currently served package intact. */
export async function removeAbandonedRecordingVodStaging(masterPath: string): Promise<void> {
  if (recordingVodHlsPreparer.isPreparing(masterPath)) return;
  const directory = vodHlsDirectory(masterPath);
  const parent = path.dirname(directory);
  const name = path.basename(directory);
  let entries: string[];
  try { entries = await fs.readdir(parent); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.part-`)) continue;
    const file = path.join(parent, entry);
    try {
      const stat = await fs.stat(file);
      // Allow any active FFmpeg up to its 90-minute deadline plus margin.
      if (Date.now() - stat.mtimeMs > 2 * 60 * 60_000 && !recordingVodHlsPreparer.isPreparing(masterPath)) {
        await fs.rm(file, { recursive: true, force: true });
      }
    } catch { /* Concurrent deletion already reclaimed it. */ }
  }
}

/** Delete only this recording's persistent package after its writer has stopped. */
export async function removeRecordingVodHlsCache(masterPath: string): Promise<void> {
  await recordingVodHlsPreparer.cancel(masterPath);
  const directory = vodHlsDirectory(masterPath);
  const parent = path.dirname(directory);
  const name = path.basename(directory);
  let entries: string[];
  try { entries = await fs.readdir(parent); } catch { return; }
  for (const entry of entries) {
    if (entry === name || entry.startsWith(`${name}.part-`)) {
      await fs.rm(path.join(parent, entry), { recursive: true, force: true });
    }
  }
}

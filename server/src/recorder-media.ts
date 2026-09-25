import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PROCESS_OUTPUT_TAIL_BYTES = 256 * 1024;
export const PROBE_TIMEOUT_MS = 2 * 60_000;
export const REMUX_TIMEOUT_MS = 30 * 60_000;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface RunProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
  killGraceMs?: number;
  backgroundPriority?: boolean;
  onStdout?: (chunk: string) => void;
}

export interface FinalizationProgress {
  phase: 'queued' | 'master' | 'probing' | 'derivative' | 'publishing';
  /** Percent of derivative media-time processed, never percent of the entire job. */
  percent: number | null;
}

export interface RecordingMediaPaths {
  part: string;
  master: string;
  derivativePart: string;
  derivative: string;
  segments?: string[];
}

export interface FinalizedRecordingMedia {
  durationSeconds: number;
  masterSize: number;
  derivativeSize: number;
  derivativeError: string | null;
}

type RunProcess = (command: string, args: string[], options?: RunProcessOptions) => Promise<ProcessResult>;

export function buildMasterCaptureArgs(
  inputUrl: string,
  outputPart: string,
  headers: Record<string, string> = {},
): string[] {
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['-headers', `${key}: ${value}\r\n`]);
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostats',
    '-nostdin',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',
    ...headerArgs,
    '-i', inputUrl,
    '-map', '0:v:0?',
    '-map', '0:a?',
    '-map', '0:d?',
    '-c', 'copy',
    '-copy_unknown',
    '-f', 'mpegts',
    '-y',
    outputPart,
  ];
}

export function buildMasterConcatArgs(segments: string[], outputPart: string): string[] {
  if (segments.length === 0) throw new Error('No capture segments available');
  return [
    '-fflags', '+genpts',
    '-i', `concat:${segments.join('|')}`,
    '-map', '0:v:0?',
    '-map', '0:a?',
    '-map', '0:d?',
    '-c', 'copy',
    '-copy_unknown',
    '-f', 'mpegts',
    '-y', outputPart,
  ];
}

export function buildDerivativeArgs(masterPath: string, derivativePartPath: string): string[] {
  return [
    '-progress', 'pipe:1', '-nostats',
    '-fflags', '+genpts',
    '-i', masterPath,
    '-map', '0:v:0?',
    '-map', '0:a?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', derivativePartPath,
  ];
}

export function buildProbeDurationArgs(masterPath: string): string[] {
  return [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    masterPath,
  ];
}

export function parseConfiguredConcurrency(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 8) : fallback;
}

export function shouldRetryCapture(retryCount: number, now: number, endTime: number, _exitCode?: number | null): boolean {
  return retryCount < 1 && now < endTime;
}

export function buildCaptureSegmentPath(directory: string, recordingId: string, attemptIndex: number): string {
  if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0) throw new Error('Invalid capture attempt index');
  return path.join(directory, `${recordingId}.segment-${String(attemptIndex).padStart(6, '0')}.ts.part`);
}

export function nextCaptureAttemptIndex(artifacts: string[], recordingId: string): number {
  const prefix = `${recordingId}.segment-`;
  let next = 0;
  for (const artifact of artifacts) {
    const name = path.basename(artifact);
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const match = /^(\d+)\.ts(?:\.part)?$/.exec(suffix);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(index)) next = Math.max(next, index + 1);
  }
  return next;
}

export function createOnceFinalizer<T>(finalize: () => Promise<T>): () => Promise<T> {
  let finalization: Promise<T> | null = null;
  return () => {
    finalization ??= finalize();
    return finalization;
  };
}

interface RecordingArtifactRecord {
  id?: string;
  file_path?: string | null;
  master_file_path?: string | null;
  derivative_file_path?: string | null;
}

export function discoverCaptureSegments(directory: string, recordingId: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const prefix = `${recordingId}.segment-`;
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(prefix) && (name.endsWith('.ts') || name.endsWith('.ts.part')))
    .sort()
    .map(name => path.join(directory, name))
    .filter(file => {
      try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; }
    });
}

/** Find unpublished media and sidecars for one recording without matching prefix siblings. */
export function discoverRecordingArtifacts(root: string, recordingId: string): string[] {
  if (!fs.existsSync(root)) return [];
  const exactPrefix = `${recordingId}.`;
  const matches: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.startsWith(exactPrefix)) {
        matches.push(fullPath);
      }
    }
  };
  walk(root);
  return matches.sort();
}

export function buildRecordingArtifactPaths(root: string, recording: RecordingArtifactRecord): string[] {
  const artifacts = new Set<string>();
  const mediaPaths = [recording.file_path, recording.master_file_path, recording.derivative_file_path]
    .filter((value): value is string => Boolean(value));
  for (const relativePath of mediaPaths) {
    const absolute = path.resolve(root, relativePath);
    if (absolute !== path.resolve(root) && !absolute.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    artifacts.add(absolute);
    artifacts.add(`${absolute}.part`);
    const stem = absolute.replace(/\.(?:ts|mp4)$/, '');
    for (const suffix of ['.edl', '.log', '.txt', '.csv', '.logo.txt']) artifacts.add(`${stem}${suffix}`);
    try {
      for (const segment of discoverCaptureSegments(path.dirname(absolute), path.basename(stem))) artifacts.add(segment);
    } catch { /* best effort */ }
  }
  return [...artifacts];
}

function appendOutputTail(current: string, chunk: unknown, limit: number): string {
  const combined = current + String(chunk);
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const outputLimit = options.outputLimitBytes ?? PROCESS_OUTPUT_TAIL_BYTES;
  const killGraceMs = options.killGraceMs ?? 5_000;
  return new Promise(resolve => {
    const child = options.backgroundPriority
      ? spawn('ionice', ['-c', '3', 'nice', '-n', '15', '--', command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
      forceKill.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', onAbort);
      if (spawnError) stderr = appendOutputTail(stderr, spawnError.message, outputLimit);
      resolve({ code, stdout, stderr, signal, timedOut, aborted });
    };

    child.stdout?.on('data', (chunk: unknown) => {
      stdout = appendOutputTail(stdout, chunk, outputLimit);
      options.onStdout?.(String(chunk));
    });
    child.stderr?.on('data', chunk => { stderr = appendOutputTail(stderr, chunk, outputLimit); });
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));

    if (options.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      deadline.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

export async function finalizeRecordingMedia(
  paths: RecordingMediaPaths,
  dependencies: { run?: RunProcess; fs?: typeof fs; signal?: AbortSignal; onProgress?: (progress: FinalizationProgress) => void } = {},
): Promise<FinalizedRecordingMedia> {
  const fileSystem = dependencies.fs ?? fs;
  const run = dependencies.run ?? runProcess;
  const report = (phase: FinalizationProgress['phase'], percent: number | null = null) => {
    dependencies.onProgress?.({ phase, percent });
  };
  report('master');
  const segments = paths.segments?.filter(segment => {
    try { return fileSystem.statSync(segment).size > 0; } catch { return false; }
  }) ?? [];

  const masterIsAuthoritative = (() => {
    try { return fileSystem.statSync(paths.master).isFile() && fileSystem.statSync(paths.master).size > 0; }
    catch { return false; }
  })();

  if (masterIsAuthoritative) {
    try { fileSystem.rmSync(paths.part, { force: true }); } catch { /* stale unpublished master part */ }
  } else if (segments.length === 1) {
    try { fileSystem.rmSync(paths.part, { force: true }); } catch { /* best effort */ }
    fileSystem.renameSync(segments[0], paths.part);
  } else if (segments.length > 1) {
    try { fileSystem.rmSync(paths.part, { force: true }); } catch { /* best effort */ }
    const concat = await run('ffmpeg', buildMasterConcatArgs(segments, paths.part), {
      signal: dependencies.signal,
      timeoutMs: REMUX_TIMEOUT_MS,
      backgroundPriority: true,
    });
    if (concat.code !== 0) {
      try { fileSystem.rmSync(paths.part, { force: true }); } catch { /* best effort */ }
      throw new Error(concat.aborted ? 'Recording finalization aborted' : concat.timedOut
        ? 'Recording master remux timed out'
        : concat.stderr.trim() || `ffmpeg exited with code ${String(concat.code)}`);
    }
  }
  if (!masterIsAuthoritative && fileSystem.existsSync(paths.part)) {
    fileSystem.renameSync(paths.part, paths.master);
  } else if (!fileSystem.existsSync(paths.master)) {
    throw new Error('No captured recording data found');
  }
  for (const segment of segments) {
    try { fileSystem.rmSync(segment, { force: true }); } catch { /* best effort */ }
  }
  const masterSize = fileSystem.statSync(paths.master).size;

  report('probing');
  const probe = await run('ffprobe', buildProbeDurationArgs(paths.master), {
    signal: dependencies.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    backgroundPriority: true,
  });
  if (probe.aborted || dependencies.signal?.aborted) throw new Error('Recording finalization aborted during duration probe');
  const probedDuration = probe.code === 0 ? Number.parseFloat(probe.stdout.trim()) : Number.NaN;
  const durationSeconds = Number.isFinite(probedDuration) && probedDuration >= 0
    ? Math.round(probedDuration)
    : 0;

  report('derivative');
  let progressBuffer = '';
  let outputMicros: number | null = null;
  let lastPercent = -1;
  const derivativeResult = await run('ffmpeg', buildDerivativeArgs(paths.master, paths.derivativePart), {
    signal: dependencies.signal,
    timeoutMs: REMUX_TIMEOUT_MS,
    backgroundPriority: true,
    onStdout: chunk => {
      progressBuffer += chunk;
      let newline = progressBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = progressBuffer.slice(0, newline).trim();
        progressBuffer = progressBuffer.slice(newline + 1);
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const value = Number(line.slice(line.indexOf('=') + 1));
          outputMicros = Number.isFinite(value) && value >= 0 ? value : null;
        } else if (line.startsWith('progress=') && probedDuration > 0 && outputMicros !== null) {
          const percent = Math.min(99, Math.floor(outputMicros / (probedDuration * 10_000)));
          if (percent > lastPercent) {
            lastPercent = percent;
            report('derivative', percent);
          }
        }
        newline = progressBuffer.indexOf('\n');
      }
      // FFmpeg progress lines are short; discard malformed/unbounded input.
      if (progressBuffer.length > 1024) progressBuffer = '';
    },
  });
  if (derivativeResult.aborted || dependencies.signal?.aborted) {
    try { fileSystem.rmSync(paths.derivativePart, { force: true }); } catch { /* best effort */ }
    throw new Error('Recording finalization aborted during derivative remux');
  }
  if (derivativeResult.code !== 0) {
    try { fileSystem.rmSync(paths.derivativePart, { force: true }); } catch { /* best effort */ }
    const detail = derivativeResult.aborted ? 'Derivative remux aborted' : derivativeResult.timedOut
      ? 'Derivative remux timed out'
      : derivativeResult.stderr.trim() || `ffmpeg exited with code ${String(derivativeResult.code)}`;
    return { durationSeconds, masterSize, derivativeSize: 0, derivativeError: detail };
  }

  try {
    report('publishing');
    fileSystem.renameSync(paths.derivativePart, paths.derivative);
    const derivativeSize = fileSystem.statSync(paths.derivative).size;
    return { durationSeconds, masterSize, derivativeSize, derivativeError: null };
  } catch (error) {
    try { fileSystem.rmSync(paths.derivativePart, { force: true }); } catch { /* best effort */ }
    const message = error instanceof Error ? error.message : String(error);
    return { durationSeconds, masterSize, derivativeSize: 0, derivativeError: message };
  }
}

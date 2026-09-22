import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteRecording,
  getConfig,
  getRecording,
  getRecordingRule,
  getRecordingRules,
  getRecordingsByRuleId,
  getRecordingsByStatus,
  updateRecording,
  updateRecordingIfStatus,
} from './db.js';
import { resolveStreamUrl, VLC_HEADERS } from './stream-utils.js';
import { logger } from './logger.js';
import { cancelCommercialAnalysis, notifyCommercialAnalysisQueued } from './commercial-analysis-worker.js';
import {
  buildCaptureSegmentPath,
  buildMasterCaptureArgs,
  buildRecordingArtifactPaths,
  createOnceFinalizer,
  discoverRecordingArtifacts,
  finalizeRecordingMedia,
  nextCaptureAttemptIndex,
  parseConfiguredConcurrency,
  shouldRetryCapture,
} from './recorder-media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'recordings');
const DEFAULT_MAX_CONCURRENT = 3;
const RETRY_DELAY_MS = 10_000;
const FORCE_KILL_DELAY_MS = 10_000;

function getRecordingsDir(): string {
  return process.env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR;
}

interface ActiveRecording {
  id: string;
  process: ChildProcess;
  retryCount: number;
  stopping: boolean;
  resumeAfterStop: boolean;
  exitCode: number | null;
  finishOnce: () => Promise<void>;
  done: Promise<void>;
}

interface StartingRecording {
  done: Promise<void>;
  resolve: () => void;
}

interface FinalizingRecording {
  controller: AbortController;
  promise: Promise<void>;
  started: boolean;
  cancelQueued: () => void;
}

const activeRecordings = new Map<string, ActiveRecording>();
const startingRecordings = new Map<string, StartingRecording>();
const finalizingRecordings = new Map<string, FinalizingRecording>();
const retryCounts = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retentionQueues = new Map<string, Promise<void>>();
let stoppingAll = false;
let finalizationQueue: Promise<void> = Promise.resolve();

function enqueueFinalization(task: () => Promise<void>, signal: AbortSignal): { promise: Promise<void>; cancelQueued: () => void } {
  const run = async () => {
    if (signal.aborted) return;
    await task();
  };
  const execution = finalizationQueue.then(run, run);
  finalizationQueue = execution.catch(() => undefined);
  let cancelQueued!: () => void;
  const cancelled = new Promise<void>(resolve => { cancelQueued = resolve; });
  return { promise: Promise.race([execution, cancelled]), cancelQueued };
}

function enqueueRuleTask<T>(ruleId: string, task: () => Promise<T> | T): Promise<T> {
  const previous = retentionQueues.get(ruleId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const queue = result.then(() => undefined, () => undefined);
  retentionQueues.set(ruleId, queue);
  const clearQueue = () => {
    if (retentionQueues.get(ruleId) === queue) retentionQueues.delete(ruleId);
  };
  void queue.then(clearQueue, clearQueue);
  return result;
}

export function getActiveCount(): number {
  return activeRecordings.size + startingRecordings.size + finalizingRecordings.size;
}

export function getCaptureCount(): number {
  return activeRecordings.size + startingRecordings.size;
}

export function isRecordingActive(id: string): boolean {
  return activeRecordings.has(id) || startingRecordings.has(id) || finalizingRecordings.has(id);
}

/** Check available disk space in bytes. Returns Infinity if unable to check. */
function getFreeDiskSpace(dir: string): number {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return Infinity;
  }
}

/** Get total disk usage of recordings directory in bytes. */
export function getRecordingsDiskUsage(): number {
  const dir = getRecordingsDir();
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* file raced with cleanup */ }
      }
    }
  };
  walk(dir);
  return total;
}

function recordingPaths(recordingsDir: string, dateDir: string, id: string) {
  const part = path.join(dateDir, `${id}.ts.part`);
  const master = path.join(dateDir, `${id}.ts`);
  const derivativePart = path.join(dateDir, `${id}.mp4.part`);
  const derivative = path.join(dateDir, `${id}.mp4`);
  return {
    part,
    master,
    derivativePart,
    derivative,
    masterRelative: path.relative(recordingsDir, master),
    derivativeRelative: path.relative(recordingsDir, derivative),
  };
}

function isCaptureSegment(file: string, id: string): boolean {
  const name = path.basename(file);
  return name.startsWith(`${id}.segment-`) && (name.endsWith('.ts') || name.endsWith('.ts.part'));
}

function normalizeLegacyCapturePart(id: string): void {
  const root = getRecordingsDir();
  let artifacts = discoverRecordingArtifacts(root, id);
  const legacyParts = artifacts.filter(file => path.basename(file) === `${id}.ts.part`);
  for (const legacyPart of legacyParts) {
    const attempt = nextCaptureAttemptIndex(artifacts, id);
    const target = buildCaptureSegmentPath(path.dirname(legacyPart), id, attempt);
    try {
      fs.renameSync(legacyPart, target);
      artifacts = [...artifacts.filter(file => file !== legacyPart), target];
    } catch (error) {
      logger.warn(`Recording ${id}: could not preserve legacy capture part: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function recoveryPaths(id: string): ReturnType<typeof recordingPaths> | null {
  const root = getRecordingsDir();
  const artifacts = discoverRecordingArtifacts(root, id);
  const preferred = artifacts.find(file => path.basename(file) === `${id}.ts`)
    ?? artifacts.find(file => path.basename(file) === `${id}.ts.part`)
    ?? artifacts.find(file => isCaptureSegment(file, id))
    ?? artifacts.find(file => path.basename(file) === `${id}.mp4.part`);
  return preferred ? recordingPaths(root, path.dirname(preferred), id) : null;
}

function removeRecordingArtifacts(id: string, verifyRemoval = false): number {
  const root = getRecordingsDir();
  const recording = getRecording(id);
  const artifacts = new Set(discoverRecordingArtifacts(root, id));
  if (recording) {
    for (const artifact of buildRecordingArtifactPaths(root, recording)) artifacts.add(artifact);
  }
  let deletedBytes = 0;
  const failures: string[] = [];
  for (const artifact of artifacts) {
    try {
      const stat = fs.statSync(artifact);
      if (stat.isFile()) deletedBytes += stat.size;
    } catch { /* file may already be gone */ }
    try {
      fs.rmSync(artifact, { force: true });
      if (verifyRemoval && fs.existsSync(artifact)) failures.push(`${artifact}: still exists after removal`);
    } catch (error) {
      if (verifyRemoval) failures.push(`${artifact}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failures.length > 0) throw new Error(`Could not remove recording artifacts: ${failures.join('; ')}`);
  return deletedBytes;
}

function completedRecordingsNewestFirst(ruleId: string) {
  return getRecordingsByRuleId(ruleId)
    .filter(recording => recording.status === 'completed')
    .sort((left, right) =>
      right.start_time - left.start_time ||
      right.created_at - left.created_at ||
      right.id.localeCompare(left.id),
    );
}

async function enforceRuleRetentionOnce(ruleId: string): Promise<void> {
  while (true) {
    const rule = getRecordingRule(ruleId);
    const limit = rule?.retention_count ?? 0;
    if (!Number.isInteger(limit) || limit <= 0) return;

    const completed = completedRecordingsNewestFirst(ruleId);
    if (completed.length <= limit) return;
    const candidate = completed.at(-1)!;
    if (isRecordingActive(candidate.id)) return;

    // Commercial-analysis cancellation can await an external process. Re-read
    // the policy and ordering afterward, immediately before synchronous removal.
    await prepareRecordingDeletion(candidate.id);
    const currentRule = getRecordingRule(ruleId);
    const currentLimit = currentRule?.retention_count ?? 0;
    if (!Number.isInteger(currentLimit) || currentLimit <= 0) return;
    const currentCompleted = completedRecordingsNewestFirst(ruleId);
    if (currentCompleted.length <= currentLimit) return;
    const stillEligible = currentCompleted.slice(currentLimit).some(recording => recording.id === candidate.id);
    const current = getRecording(candidate.id);
    if (!stillEligible || !current || current.status !== 'completed' || current.rule_id !== ruleId || isRecordingActive(candidate.id)) {
      continue;
    }

    try {
      const deletedBytes = removeRecordingArtifacts(candidate.id, true);
      deleteRecording(candidate.id);
      logger.info(
        `Recording rule ${ruleId}: removed oldest completed recording ${candidate.id} ` +
        `(${deletedBytes} bytes) to keep the latest ${currentLimit}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Recording rule ${ruleId}: retained metadata after media deletion failed for ${candidate.id}: ${message}`);
      throw new Error(`Retention cleanup incomplete for ${candidate.id}: ${message}`, { cause: error });
    }
  }
}

/** Apply a rule's rolling completed-recording limit without touching in-flight work. */
export function enforceRuleRetention(ruleId: string): Promise<void> {
  return enqueueRuleTask(ruleId, () => enforceRuleRetentionOnce(ruleId));
}

/** Serialize rule mutations with destructive retention work for the same rule. */
export function withRuleRetentionLock<T>(ruleId: string, task: () => Promise<T> | T): Promise<T> {
  return enqueueRuleTask(ruleId, task);
}

/** Reconcile every persisted rolling rule after restarts or interrupted cleanup. */
export async function enforceAllRuleRetentions(): Promise<void> {
  for (const rule of getRecordingRules()) {
    if (rule.retention_count <= 0) continue;
    try {
      await enforceRuleRetention(rule.id);
    } catch (error) {
      logger.error(`Recording rule ${rule.id}: retention backstop failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** Cancel surplus future airings when a recurring rule becomes record-once. */
export async function reconcileRecordOnceRule(ruleId: string): Promise<void> {
  const rule = getRecordingRule(ruleId);
  if (!rule || rule.airing_policy !== 'once') return;
  const recordings = getRecordingsByRuleId(ruleId);
  const hasAccepted = recordings.some(recording =>
    ['recording', 'finalizing', 'completed'].includes(recording.status),
  );
  const scheduled = recordings
    .filter(recording => recording.status === 'scheduled')
    .sort((left, right) => left.start_time - right.start_time || left.created_at - right.created_at || left.id.localeCompare(right.id));
  const keepId = hasAccepted ? null : scheduled[0]?.id ?? null;
  for (const recording of scheduled) {
    if (recording.id !== keepId) await cancelRecording(recording.id);
  }
}

async function publishCompletedRecording(
  id: string,
  paths: ReturnType<typeof recordingPaths>,
): Promise<void> {
  const existing = finalizingRecordings.get(id);
  if (existing) return existing.promise;

  const current = getRecording(id);
  if (!current || current.status === 'cancelled') return;
  if (current.status !== 'finalizing' &&
      !updateRecordingIfStatus(id, ['recording', 'scheduled'], { status: 'finalizing', error: null })) {
    return;
  }

  const controller = new AbortController();
  const entry: FinalizingRecording = { controller, promise: Promise.resolve(), started: false, cancelQueued: () => {} };
  let completedRuleId: string | null = null;
  const queuedFinalization = enqueueFinalization(async () => {
    entry.started = true;
    try {
      const segments = discoverRecordingArtifacts(getRecordingsDir(), id)
        .filter(file => isCaptureSegment(file, id));
      const result = await finalizeRecordingMedia({ ...paths, segments }, { signal: controller.signal });
      const hasDerivative = result.derivativeError === null;
      const now = Date.now();
      const published = updateRecordingIfStatus(id, ['finalizing'], {
        status: 'completed',
        actual_end: now,
        master_file_path: paths.masterRelative,
        derivative_file_path: hasDerivative ? paths.derivativeRelative : null,
        derivative_error: result.derivativeError,
        file_path: hasDerivative ? paths.derivativeRelative : paths.masterRelative,
        file_size: result.masterSize + (hasDerivative ? result.derivativeSize : 0),
        duration: result.durationSeconds,
        error: null,
        analysis_state: 'queued',
        analysis_error: null,
        analysis_requested_at: now,
        analysis_started_at: null,
        analysis_completed_at: null,
      });
      if (!published) {
        removeRecordingArtifacts(id);
        return;
      }
      completedRuleId = current.rule_id ?? null;
      notifyCommercialAnalysisQueued();
      logger.info(
        `Recording ${id}: completed (${(result.masterSize / 1e6).toFixed(1)}MB master, ${result.durationSeconds}s)` +
        (result.derivativeError ? `; MP4 derivative failed: ${result.derivativeError}` : ''),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted && stoppingAll) {
        logger.info(`Recording ${id}: finalization deferred for restart`);
        return;
      }
      const failed = updateRecordingIfStatus(id, ['finalizing'], {
        status: 'failed',
        actual_end: Date.now(),
        error: `Failed to finalize recording: ${message}`,
      });
      if (failed) logger.error(`Recording ${id}: failed to finalize master: ${message}`);
      else removeRecordingArtifacts(id);
    } finally {
      if (finalizingRecordings.get(id)?.controller === controller) finalizingRecordings.delete(id);
      retryCounts.delete(id);
    }
  }, controller.signal);
  entry.cancelQueued = queuedFinalization.cancelQueued;
  const finalization = queuedFinalization.promise;
  const promise = finalization.then(async () => {
    if (!completedRuleId) return;
    try {
      await enforceRuleRetention(completedRuleId);
    } catch (error) {
      logger.warn(`Recording ${id}: rolling retention cleanup failed: ${error instanceof Error ? error.message : error}`);
    }
  });
  entry.promise = promise;
  finalizingRecordings.set(id, entry);
  return promise;
}

function createStartingRecording(id: string): StartingRecording {
  let resolve!: () => void;
  const done = new Promise<void>(settle => { resolve = settle; });
  const starting = { done, resolve };
  startingRecordings.set(id, starting);
  return starting;
}

function finishStartingRecording(id: string, starting: StartingRecording): void {
  if (startingRecordings.get(id) === starting) startingRecordings.delete(id);
  starting.resolve();
}

function scheduleRetry(id: string): void {
  const previous = retryTimers.get(id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    retryTimers.delete(id);
    void startRecording(id);
  }, RETRY_DELAY_MS);
  timer.unref?.();
  retryTimers.set(id, timer);
}

export async function startRecording(id: string): Promise<void> {
  if (stoppingAll || isRecordingActive(id)) return;
  const rec = getRecording(id);
  if (!rec || rec.status === 'cancelled') {
    if (!rec) logger.error(`Recording ${id} not found`);
    return;
  }

  const recordingsDir = getRecordingsDir();
  fs.mkdirSync(recordingsDir, { recursive: true });
  normalizeLegacyCapturePart(id);

  if (Date.now() >= rec.end_time) {
    const recovered = recoveryPaths(id);
    if (recovered) await publishCompletedRecording(id, recovered);
    else updateRecordingIfStatus(id, ['scheduled', 'recording'], {
      status: 'failed', error: 'Recording window ended before capture started', actual_end: Date.now(),
    });
    return;
  }

  const maxConcurrent = parseConfiguredConcurrency(
    getConfig('max_concurrent_recordings', String(DEFAULT_MAX_CONCURRENT)),
    DEFAULT_MAX_CONCURRENT,
  );
  if (getCaptureCount() >= maxConcurrent) {
    logger.warn(`Recording ${id}: capture concurrency temporarily saturated (${maxConcurrent}); leaving scheduled`);
    return;
  }

  const freeSpace = getFreeDiskSpace(recordingsDir);
  if (freeSpace < 1_073_741_824) {
    updateRecording(id, { status: 'failed', error: 'Insufficient disk space (< 1GB free)' });
    logger.error(`Recording ${id}: insufficient disk space (${(freeSpace / 1e9).toFixed(1)}GB free)`);
    return;
  }

  const now = new Date();
  const dateDir = path.join(
    recordingsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dateDir, { recursive: true });
  const paths = recordingPaths(recordingsDir, dateDir, id);
  const attemptIndex = nextCaptureAttemptIndex(discoverRecordingArtifacts(recordingsDir, id), id);
  const capturePart = buildCaptureSegmentPath(dateDir, id, attemptIndex);

  const starting = createStartingRecording(id);
  let streamUrl: string;
  try {
    streamUrl = await resolveStreamUrl(rec.channel_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve stream URL';
    updateRecordingIfStatus(id, ['scheduled', 'recording'], { status: 'failed', error: message });
    logger.error(`Recording ${id}: ${message}`);
    finishStartingRecording(id, starting);
    return;
  }

  const current = getRecording(id);
  if (stoppingAll || !current || current.status === 'cancelled') {
    finishStartingRecording(id, starting);
    return;
  }

  const retryCount = retryCounts.get(id) ?? 0;
  logger.info(`Recording ${id}: starting stream-copy attempt ${attemptIndex + 1} for "${rec.title}" → ${path.relative(recordingsDir, capturePart)}`);
  const ffmpeg = spawn('ffmpeg', buildMasterCaptureArgs(streamUrl, capturePart, VLC_HEADERS), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const active = {} as ActiveRecording;
  const finishAttempt = createOnceFinalizer(async () => {
    if (activeRecordings.get(id) === active) activeRecordings.delete(id);
    const recording = getRecording(id);
    if (!recording || recording.status === 'cancelled') return;

    if (active.stopping) {
      if (stoppingAll) {
        updateRecordingIfStatus(id, ['recording'], active.resumeAfterStop
          ? { status: 'scheduled', actual_end: null, error: null }
          : { status: 'finalizing', actual_end: Date.now(), error: null });
        return;
      }
      if (active.resumeAfterStop) {
        updateRecordingIfStatus(id, ['recording'], {
          status: 'scheduled', actual_end: null, error: null,
        });
        return;
      }
      await publishCompletedRecording(id, paths);
      return;
    }

    const endedAt = Date.now();
    if (shouldRetryCapture(active.retryCount, endedAt, recording.end_time, active.exitCode)) {
      retryCounts.set(id, active.retryCount + 1);
      updateRecordingIfStatus(id, ['recording'], { status: 'scheduled', error: null });
      logger.warn(`Recording ${id}: ffmpeg exited early with code ${String(active.exitCode)}, retrying once in 10s...`);
      scheduleRetry(id);
      return;
    }

    await publishCompletedRecording(id, paths);
  });

  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  Object.assign(active, {
    id,
    process: ffmpeg,
    retryCount,
    stopping: false,
    resumeAfterStop: false,
    exitCode: null,
    finishOnce: finishAttempt,
    done,
  });
  activeRecordings.set(id, active);
  finishStartingRecording(id, starting);

  const markedRecording = updateRecordingIfStatus(id, ['scheduled', 'recording'], {
    status: 'recording',
    actual_start: rec.actual_start ?? Date.now(),
    actual_end: null,
    file_path: null,
    master_file_path: null,
    derivative_file_path: null,
    derivative_error: null,
    error: null,
  });
  if (!markedRecording) {
    ffmpeg.kill('SIGKILL');
  }

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.debug(`ffmpeg [${id}]: ${line}`);
  });
  const settle = () => {
    void active.finishOnce().catch(error => {
      logger.error(`Recording ${id}: terminal capture handling failed: ${error instanceof Error ? error.message : error}`);
    }).finally(resolveDone);
  };
  ffmpeg.once('close', code => {
    active.exitCode = code;
    settle();
  });
  ffmpeg.once('error', error => {
    logger.error(`Recording ${id}: ffmpeg error: ${error.message}`);
    settle();
  });
}

export async function stopRecording(id: string, preserveIfFuture = false): Promise<void> {
  const starting = startingRecordings.get(id);
  if (starting) await starting.done;

  const active = activeRecordings.get(id);
  if (!active) {
    const finalizing = finalizingRecordings.get(id);
    if (finalizing) await finalizing.promise;
    return;
  }

  logger.info(`Recording ${id}: stopping...`);
  const recording = getRecording(id);
  active.resumeAfterStop = preserveIfFuture && Boolean(recording && Date.now() < recording.end_time);
  active.stopping = true;
  active.process.kill('SIGINT');
  const forceKillTimer = setTimeout(() => {
    if (activeRecordings.get(id) === active) {
      logger.warn(`Recording ${id}: force killing ffmpeg`);
      active.process.kill('SIGKILL');
    }
  }, FORCE_KILL_DELAY_MS);
  forceKillTimer.unref?.();
  try {
    await active.done;
  } finally {
    clearTimeout(forceKillTimer);
  }
}

export async function cancelRecording(id: string, _deleteFile = false): Promise<void> {
  updateRecording(id, { status: 'cancelled', actual_end: Date.now() });
  retryCounts.delete(id);
  const retryTimer = retryTimers.get(id);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimers.delete(id);

  const starting = startingRecordings.get(id);
  if (starting) await starting.done;

  const active = activeRecordings.get(id);
  if (active) {
    active.process.kill('SIGKILL');
    await active.done;
  }

  const finalizing = finalizingRecordings.get(id);
  if (finalizing) {
    finalizing.controller.abort();
    if (finalizing.started) await finalizing.promise;
    else {
      finalizing.cancelQueued();
      await finalizing.promise;
      if (finalizingRecordings.get(id) === finalizing) finalizingRecordings.delete(id);
    }
  }

  // Capture/finalization artifacts are unpublished and unusable after cancellation;
  // always remove them so cancelled rows cannot strand disk space. `deleteFile`
  // is retained for API compatibility and logging only.
  removeRecordingArtifacts(id);
  logger.info(`Recording ${id}: cancelled${_deleteFile ? ' (file deleted)' : ''}`);
}

/** Stop active writers and analysis before removing a recording's artifacts. */
async function prepareRecordingDeletion(id: string): Promise<void> {
  await cancelCommercialAnalysis(id);
  if (isRecordingActive(id)) await cancelRecording(id, false);
}

/** Await any writer for this recording, then remove every exact-id artifact. */
export async function deleteRecordingFile(id: string): Promise<number> {
  await prepareRecordingDeletion(id);
  return removeRecordingArtifacts(id, true);
}

/** Stop captures gracefully and await capture finalization before database shutdown. */
export async function stopAllRecordings(): Promise<void> {
  stoppingAll = true;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  await Promise.all([...startingRecordings.values()].map(starting => starting.done));
  await Promise.all([...activeRecordings.keys()].map(id => stopRecording(id, true)));
  const finalizers = [...finalizingRecordings.entries()];
  for (const [, finalizing] of finalizers) {
    finalizing.controller.abort();
    if (!finalizing.started) finalizing.cancelQueued();
  }
  await Promise.all(finalizers.map(([, finalizing]) => finalizing.promise));
  for (const [id, finalizing] of finalizers) {
    if (finalizingRecordings.get(id) === finalizing) finalizingRecordings.delete(id);
  }
}

/** Get full path for the preferred recording playback file. */
export function getRecordingFilePath(id: string): string | null {
  const rec = getRecording(id);
  if (!rec?.file_path) return null;
  const fullPath = path.resolve(getRecordingsDir(), rec.file_path);
  const root = path.resolve(getRecordingsDir());
  if (!fullPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(fullPath)) return null;
  return fullPath;
}

/** Get full path for the finalized master transport stream. */
export function getRecordingMasterFilePath(id: string): string | null {
  const rec = getRecording(id);
  if (!rec?.master_file_path) return null;
  const fullPath = path.resolve(getRecordingsDir(), rec.master_file_path);
  const root = path.resolve(getRecordingsDir());
  if (!fullPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(fullPath)) return null;
  return fullPath;
}

/** Recover captures and finalization interrupted by a server stop. */
export async function recoverRecordings(): Promise<void> {
  const interrupted = [
    ...getRecordingsByStatus('recording'),
    ...getRecordingsByStatus('finalizing'),
  ];
  const cancelled = getRecordingsByStatus('cancelled');
  for (const rec of cancelled) removeRecordingArtifacts(rec.id);
  const now = Date.now();

  // Restore every still-live capture first so the scheduler can resume it on its
  // immediate startup tick, regardless of how long older media takes to finish.
  for (const rec of interrupted) {
    if (rec.status === 'recording' && now < rec.end_time) {
      normalizeLegacyCapturePart(rec.id);
      logger.info(`Recovering recording ${rec.id}: "${rec.title}" (still within time window)`);
      updateRecordingIfStatus(rec.id, ['recording'], { status: 'scheduled', error: null });
    }
  }

  for (const rec of interrupted) {
    if (rec.status === 'recording' && now < rec.end_time) continue;
    normalizeLegacyCapturePart(rec.id);
    const paths = recoveryPaths(rec.id);
    if (paths) {
      logger.info(`Recovering recording ${rec.id}: finalizing captured media`);
      updateRecordingIfStatus(rec.id, ['recording'], { status: 'finalizing', error: null });
      void publishCompletedRecording(rec.id, paths);
    } else {
      logger.warn(`Recording ${rec.id}: interrupted without recoverable media, marking failed`);
      updateRecordingIfStatus(rec.id, ['recording', 'finalizing'], {
        status: 'failed', error: 'Server restarted without recoverable capture data', actual_end: now,
      });
    }
  }
}

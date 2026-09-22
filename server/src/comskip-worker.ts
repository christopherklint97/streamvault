import path from 'node:path';
import type { CommercialSegmentWrite } from './commercial-store.js';
import { parseComskipEdl, validateCommercialIntervals } from './commercial-intervals.js';
import type { ProcessResult, RunProcessOptions } from './recorder-media.js';

export const COMSKIP_DETECTOR_VERSION = process.env.COMSKIP_REVISION || 'a140b6a';
export const COMSKIP_PROFILE_VERSION = process.env.COMSKIP_PROFILE_HASH || 'espn-v1';
export const COMSKIP_TIMEOUT_MS = 6 * 60 * 60_000;

export interface QueuedAnalysisRecording {
  id: string;
  master_file_path?: string | null;
  duration: number;
  status: string;
  analysis_state?: string;
}

export interface CommercialWorkerDependencies {
  recoverStaleAnalysis(): number;
  claimNextQueuedAnalysis(now: number): QueuedAnalysisRecording | undefined;
  failAnalysis(id: string, message: string, now: number): boolean;
  completeAnalysis(
    id: string,
    segments: CommercialSegmentWrite[],
    state: 'review_needed' | 'ready',
    profile: string,
    now: number,
  ): boolean;
  readFile(filePath: string): string;
  removeFile(filePath: string): void;
  run(command: string, args: string[], options?: RunProcessOptions): Promise<ProcessResult>;
  binaryAvailable(binaryPath: string): boolean;
  canAnalyze(): boolean;
  recordingsDir: string;
  binaryPath: string;
  profilePath: string;
  now(): number;
}

export interface CommercialWorkerOptions {
  pollIntervalMs?: number;
}

function safeMasterPath(recordingsDir: string, relativePath: string): string | null {
  const root = path.resolve(recordingsDir);
  const master = path.resolve(root, relativePath);
  return master.startsWith(`${root}${path.sep}`) ? master : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCommercialAnalysisWorker(
  dependencies: CommercialWorkerDependencies,
  options: CommercialWorkerOptions = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activePromise: Promise<boolean> | null = null;
  let activeController: AbortController | null = null;
  let activeRecordingId: string | null = null;
  let stopped = false;

  const fail = (id: string, message: string) => {
    if (!stopped) dependencies.failAnalysis(id, message, dependencies.now());
  };

  const processOne = async (): Promise<boolean> => {
    if (!dependencies.canAnalyze()) return false;
    const recording = dependencies.claimNextQueuedAnalysis(dependencies.now());
    if (!recording) return false;
    const controller = new AbortController();
    activeController = controller;
    activeRecordingId = recording.id;
    try {
      if (!worker.isAvailable()) {
        fail(recording.id, `Comskip unavailable at ${dependencies.binaryPath}`);
        return true;
      }
      if (recording.status !== 'completed' || !recording.master_file_path) {
        fail(recording.id, 'Commercial analysis requires a completed master recording');
        return true;
      }
      const masterPath = safeMasterPath(dependencies.recordingsDir, recording.master_file_path);
      if (!masterPath) {
        fail(recording.id, 'Commercial analysis master path is invalid');
        return true;
      }
      if (!Number.isFinite(recording.duration) || recording.duration <= 0) {
        fail(recording.id, 'Commercial analysis requires a probed recording duration');
        return true;
      }

      const outputDirectory = path.dirname(masterPath);
      const edlPath = path.join(outputDirectory, `${path.basename(masterPath, path.extname(masterPath))}.edl`);
      try { dependencies.removeFile(edlPath); } catch { /* stale detector output is unsafe */ }
      const result = await dependencies.run(dependencies.binaryPath, [
        `--ini=${dependencies.profilePath}`,
        `--output=${outputDirectory}`,
        masterPath,
      ], { signal: controller.signal, timeoutMs: COMSKIP_TIMEOUT_MS, backgroundPriority: true });
      if (stopped || controller.signal.aborted || result.aborted) return true;
      if (result.code !== 0) {
        const detail = result.timedOut
          ? 'Comskip analysis timed out'
          : result.stderr.trim() || `Comskip exited with code ${String(result.code)}`;
        fail(recording.id, detail);
        return true;
      }

      const parsed = parseComskipEdl(dependencies.readFile(edlPath));
      const validated = validateCommercialIntervals(parsed, recording.duration);
      const segments = validated.map(segment => ({
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        detector: 'comskip',
        confidence: null,
        detectorVersion: COMSKIP_DETECTOR_VERSION,
        reviewState: 'suggested',
      }));
      dependencies.completeAnalysis(
        recording.id,
        segments,
        validated.length > 0 ? 'review_needed' : 'ready',
        COMSKIP_PROFILE_VERSION,
        dependencies.now(),
      );
      return true;
    } catch (error) {
      if (!stopped && !controller.signal.aborted) fail(recording.id, errorMessage(error));
      return true;
    } finally {
      if (activeController === controller) activeController = null;
      if (activeRecordingId === recording.id) activeRecordingId = null;
    }
  };

  const worker = {
    isAvailable(): boolean {
      return dependencies.binaryAvailable(dependencies.binaryPath);
    },

    runNext(): Promise<boolean> {
      if (activePromise || stopped) return Promise.resolve(false);
      activePromise = processOne().finally(() => { activePromise = null; });
      return activePromise;
    },

    start(): void {
      if (timer) return;
      stopped = false;
      dependencies.recoverStaleAnalysis();
      timer = setInterval(() => { void worker.runNext(); }, pollIntervalMs);
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      activeController?.abort();
      await activePromise;
    },

    async cancelRecording(recordingId: string): Promise<void> {
      if (activeRecordingId !== recordingId) return;
      const pending = activePromise;
      activeController?.abort();
      await pending;
    },

    notify(): void {
      if (!stopped) void worker.runNext();
    },
  };

  return worker;
}

// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBRecording } from './db.js';
import type { RecordingMediaPaths, RunProcessOptions } from './recorder-media.js';

const state = vi.hoisted(() => ({
  records: new Map<string, DBRecording>(),
  spawned: [] as Array<{ process: EventEmitter & Record<string, unknown>; args: string[] }>,
  finalize: undefined as undefined | ((paths: RecordingMediaPaths, dependencies?: { signal?: AbortSignal }) => Promise<{
    durationSeconds: number;
    masterSize: number;
    derivativeSize: number;
    derivativeError: string | null;
  }>),
  analysisNotifications: 0,
  maxConcurrent: '3',
  cancelAnalysis: undefined as undefined | ((id: string) => Promise<void>),
}));

vi.mock('./db.js', () => ({
  getConfig: (key: string, fallback = '') => key === 'max_concurrent_recordings' ? state.maxConcurrent : fallback,
  getRecording: (id: string) => state.records.get(id),
  getRecordingsByStatus: (status: string) => [...state.records.values()].filter(recording => recording.status === status),
  updateRecording: (id: string, updates: Partial<DBRecording>) => {
    const current = state.records.get(id);
    if (current) state.records.set(id, { ...current, ...updates });
  },
  updateRecordingIfStatus: (id: string, statuses: string[], updates: Partial<DBRecording>) => {
    const current = state.records.get(id);
    if (!current || !statuses.includes(current.status)) return false;
    state.records.set(id, { ...current, ...updates });
    return true;
  },
}));

vi.mock('./stream-utils.js', () => ({
  VLC_HEADERS: {},
  resolveStreamUrl: vi.fn(async () => 'https://example.test/live'),
}));

vi.mock('./commercial-analysis-worker.js', () => ({
  notifyCommercialAnalysisQueued: () => { state.analysisNotifications += 1; },
  cancelCommercialAnalysis: (id: string) => state.cancelAnalysis?.(id) ?? Promise.resolve(),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: string[]) => {
      const process = new EventEmitter() as EventEmitter & Record<string, unknown>;
      process.stderr = new EventEmitter();
      process.exitCode = null;
      process.kill = vi.fn((signal: NodeJS.Signals) => {
        queueMicrotask(() => {
          process.exitCode = signal === 'SIGINT' ? 255 : null;
          process.emit('close', process.exitCode);
        });
        return true;
      });
      state.spawned.push({ process, args });
      return process;
    }),
  };
});

vi.mock('./recorder-media.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./recorder-media.js')>();
  return {
    ...actual,
    finalizeRecordingMedia: (paths: RecordingMediaPaths, dependencies?: { signal?: AbortSignal; options?: RunProcessOptions }) => {
      if (!state.finalize) throw new Error('finalize mock not configured');
      return state.finalize(paths, dependencies);
    },
  };
});

function recording(overrides: Partial<DBRecording> = {}): DBRecording {
  return {
    id: 'r1', channel_id: 'c1', channel_name: 'Channel', title: 'Show', status: 'scheduled',
    start_time: 1_000, end_time: 120_000, actual_start: null, actual_end: null,
    file_path: null, file_size: 0, duration: 0, error: null, rule_id: null,
    program_title: 'Show', created_at: 1_000, ...overrides,
  };
}

function finishCapture(index: number, code: number): void {
  const spawned = state.spawned[index];
  const output = spawned.args.at(-1)!;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `attempt-${index}`);
  spawned.process.exitCode = code;
  spawned.process.emit('close', code);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let recordingsDir = '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  state.records.clear();
  state.spawned.length = 0;
  state.analysisNotifications = 0;
  state.maxConcurrent = '3';
  state.cancelAnalysis = undefined;
  recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-integration-'));
  process.env.RECORDINGS_DIR = recordingsDir;
  state.finalize = async paths => {
    const segments = paths.segments ?? [];
    const masterSize = segments.reduce((total, segment) => total + fs.statSync(segment).size, 0);
    fs.writeFileSync(paths.master, 'master');
    fs.writeFileSync(paths.derivative, 'mp4');
    return { durationSeconds: 30, masterSize, derivativeSize: 3, derivativeError: null };
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RECORDINGS_DIR;
  fs.rmSync(recordingsDir, { recursive: true, force: true });
});

describe('recorder lifecycle integration', () => {
  it('directly cancelling a scheduled recording removes every unpublished artifact', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    for (const name of ['r1.segment-000000.ts.part', 'r1.ts.part', 'r1.mp4.part', 'r1.edl']) {
      fs.writeFileSync(path.join(nested, name), name);
    }
    state.records.set('r1', recording());
    const recorder = await import('./recorder.js');

    await recorder.cancelRecording('r1');

    expect(state.records.get('r1')?.status).toBe('cancelled');
    const remainingFiles = fs.readdirSync(recordingsDir, { recursive: true })
      .map(entry => path.join(recordingsDir, String(entry)))
      .filter(entry => fs.statSync(entry).isFile());
    expect(remainingFiles).toEqual([]);
  });

  it('awaits commercial analysis cancellation before deleting media and sidecars', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    const master = path.join(nested, 'r1.ts');
    const sidecar = path.join(nested, 'r1.edl');
    fs.writeFileSync(master, 'master');
    fs.writeFileSync(sidecar, 'analysis-output');
    state.records.set('r1', recording({
      status: 'completed', file_path: '2026/09/20/r1.ts', master_file_path: '2026/09/20/r1.ts',
      analysis_state: 'analyzing',
    }));
    let release!: () => void;
    let cancellationStarted = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.cancelAnalysis = async id => {
      expect(id).toBe('r1');
      cancellationStarted = true;
      await blocked;
    };
    const recorder = await import('./recorder.js');

    const deleting = recorder.deleteRecordingFile('r1');
    await flush();
    const masterExistedWhileCancelling = fs.existsSync(master);
    const sidecarExistedWhileCancelling = fs.existsSync(sidecar);
    release();
    await deleting;

    expect(cancellationStarted).toBe(true);
    expect(masterExistedWhileCancelling).toBe(true);
    expect(sidecarExistedWhileCancelling).toBe(true);
    expect(fs.existsSync(master)).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it('retries a clean early EOF into a new segment and finalizes every attempt', async () => {
    state.records.set('r1', recording());
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    finishCapture(0, 0);
    await flush();
    expect(state.records.get('r1')?.status).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.spawned).toHaveLength(2);
    expect(state.spawned[0].args.at(-1)).toMatch(/r1\.segment-000000\.ts\.part$/);
    expect(state.spawned[1].args.at(-1)).toMatch(/r1\.segment-000001\.ts\.part$/);

    const stopped = recorder.stopRecording('r1');
    await stopped;

    expect(state.records.get('r1')).toMatchObject({ status: 'completed', duration: 30 });
    expect(state.analysisNotifications).toBe(1);
  });

  it('aborts finalization before deletion so cancelled work cannot republish or leave artifacts', async () => {
    state.records.set('r1', recording());
    let observedSignal: AbortSignal | undefined;
    state.finalize = async (_paths, dependencies) => {
      observedSignal = dependencies?.signal;
      await new Promise<void>((_resolve, reject) => observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    };
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    const capturePath = state.spawned[0].args.at(-1)!;
    fs.writeFileSync(capturePath, 'attempt');
    const stopping = recorder.stopRecording('r1');
    await flush();
    expect(observedSignal).toBeDefined();
    const cancellation = recorder.cancelRecording('r1');
    await Promise.all([stopping, cancellation]);

    expect(observedSignal?.aborted).toBe(true);
    expect(state.records.get('r1')?.status).toBe('cancelled');
    const remainingFiles = fs.readdirSync(recordingsDir, { recursive: true })
      .map(entry => path.join(recordingsDir, String(entry)))
      .filter(entry => fs.statSync(entry).isFile());
    expect(remainingFiles).toEqual([]);
    expect(state.analysisNotifications).toBe(0);
  });

  it('leaves a due recording scheduled when capture concurrency is temporarily saturated', async () => {
    state.maxConcurrent = '1';
    state.records.set('r1', recording());
    state.records.set('r2', recording({ id: 'r2' }));
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    await recorder.startRecording('r2');

    expect(state.records.get('r2')).toMatchObject({ status: 'scheduled', error: null });
    await Promise.all([recorder.cancelRecording('r1'), recorder.cancelRecording('r2')]);
  });

  it('does not count derivative finalization against the capture concurrency limit', async () => {
    state.maxConcurrent = '1';
    state.records.set('r1', recording());
    state.records.set('r2', recording({ id: 'r2' }));
    let releaseFinalization!: () => void;
    let finalizationStarted!: () => void;
    const started = new Promise<void>(resolve => { finalizationStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseFinalization = resolve; });
    state.finalize = async paths => {
      finalizationStarted();
      await blocked;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured');
    const stopping = recorder.stopRecording('r1');
    await started;
    await recorder.startRecording('r2');
    const r2StatusWhileR1Finalizes = state.records.get('r2')?.status;
    const spawnCount = state.spawned.length;
    await recorder.cancelRecording('r2');
    releaseFinalization();
    await stopping;

    expect(r2StatusWhileR1Finalizes).toBe('recording');
    expect(spawnCount).toBe(2);
  });

  it('recovers legacy partial capture data and finalizes it after the recording window', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'r1.ts.part'), 'legacy');
    state.records.set('r1', recording({ status: 'recording', end_time: 5_000 }));
    const recorder = await import('./recorder.js');

    await recorder.recoverRecordings();

    expect(state.records.get('r1')?.status).toBe('completed');
    expect(state.records.get('r1')?.master_file_path).toMatch(/r1\.ts$/);
    expect(state.analysisNotifications).toBe(1);
  });

  it('requeues live recordings before returning without awaiting past-end finalization', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'r-past.segment-000000.ts.part'), 'past');
    state.records.set('r-past', recording({ id: 'r-past', status: 'recording', end_time: 5_000 }));
    state.records.set('r-live', recording({ id: 'r-live', status: 'recording', end_time: 120_000 }));
    let releaseFinalization!: () => void;
    let finalizationStarted!: () => void;
    const started = new Promise<void>(resolve => { finalizationStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseFinalization = resolve; });
    state.finalize = async paths => {
      finalizationStarted();
      await blocked;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');
    let returned = false;

    const recovery = recorder.recoverRecordings().then(() => { returned = true; });
    await started;
    await flush();
    const returnedBeforeFinalization = returned;
    const liveStatusBeforeFinalization = state.records.get('r-live')?.status;
    releaseFinalization();
    await recovery;
    await vi.waitFor(() => expect(state.records.get('r-past')?.status).toBe('completed'));

    expect(returnedBeforeFinalization).toBe(true);
    expect(liveStatusBeforeFinalization).toBe('scheduled');
  });

  it('preserves a future-end capture as scheduled and resumable during shutdown', async () => {
    state.records.set('r1', recording({ end_time: 120_000 }));
    const recorder = await import('./recorder.js');
    await recorder.startRecording('r1');
    const capturePath = state.spawned[0].args.at(-1)!;
    fs.writeFileSync(capturePath, 'partial-at-shutdown');

    await recorder.stopAllRecordings();

    expect(state.records.get('r1')).toMatchObject({ status: 'scheduled', error: null });
    expect(fs.readFileSync(capturePath, 'utf8')).toBe('partial-at-shutdown');
    expect(state.analysisNotifications).toBe(0);
  });
});

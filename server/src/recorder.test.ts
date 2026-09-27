// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBRecording, DBRecordingRule } from './db.js';
import type { FinalizationProgress, RecordingMediaPaths, RunProcessOptions } from './recorder-media.js';

const state = vi.hoisted(() => ({
  records: new Map<string, DBRecording>(),
  rules: new Map<string, DBRecordingRule>(),
  deleted: [] as string[],
  spawned: [] as Array<{ process: EventEmitter & Record<string, unknown>; args: string[] }>,
  finalize: undefined as undefined | ((paths: RecordingMediaPaths, dependencies?: { signal?: AbortSignal; onProgress?: (progress: FinalizationProgress) => void }) => Promise<{
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
  getRecordingRule: (id: string) => state.rules.get(id),
  getRecordingRules: () => [...state.rules.values()],
  getRecordingsByRuleId: (ruleId: string) => [...state.records.values()].filter(recording => recording.rule_id === ruleId),
  getRecordingsByStatus: (status: string) => [...state.records.values()].filter(recording => recording.status === status),
  deleteRecording: (id: string) => {
    state.deleted.push(id);
    state.records.delete(id);
  },
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
  completeRecordingAndAdvanceCadence: (
    id: string, updates: Partial<DBRecording>, ruleId: string | null, revision: number | null,
    programStart: number | null, airingKey: string | null,
  ) => {
    const current = state.records.get(id);
    if (!current || current.status !== 'finalizing') return false;
    state.records.set(id, { ...current, ...updates });
    const rule = ruleId ? state.rules.get(ruleId) : undefined;
    if (rule && revision === rule.rule_revision && programStart !== null) {
      state.rules.set(rule.id, {
        ...rule,
        cadence_last_success_start: programStart,
        cadence_last_success_key: airingKey,
        cadence_occurrence_progress: 0,
        cadence_cursor_start: programStart,
        cadence_cursor_key: airingKey,
        cadence_retry_start: null,
        cadence_retry_key: null,
      });
    }
    return true;
  },
  markRecordingRuleCadenceRetry: (id: string | null, revision: number | null, start: number | null, key: string | null) => {
    const rule = id ? state.rules.get(id) : undefined;
    if (!rule || rule.rule_revision !== revision || start === null) return false;
    state.rules.set(rule.id, { ...rule, cadence_retry_start: start, cadence_retry_key: key });
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
    finalizeRecordingMedia: (paths: RecordingMediaPaths, dependencies?: { signal?: AbortSignal; options?: RunProcessOptions; onProgress?: (progress: FinalizationProgress) => void }) => {
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

function rule(overrides: Partial<DBRecordingRule> = {}): DBRecordingRule {
  return {
    id: 'rule-1', channel_id: 'c1', channel_name: 'Channel', match_title: 'Show',
    match_type: 'exact', enabled: 1, padding_before: 0, padding_after: 0,
    max_recordings: 0, retention_count: 1, airing_policy: 'every', repeat_policy: 'include_unknown',
    cadence_mode: 'every', cadence_interval: 1, daily_start_minutes: 0, schedule_timezone: 'UTC',
    rule_revision: 1, cadence_last_success_start: null, cadence_last_success_key: null, created_at: 1,
    cadence_occurrence_progress: 0, cadence_cursor_start: null, cadence_cursor_key: null,
    cadence_retry_start: null, cadence_retry_key: null,
    ...overrides,
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
  state.rules.clear();
  state.deleted.length = 0;
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
  it('exposes live finalization phase and measured percent, then clears it at completion', async () => {
    state.records.set('r1', recording());
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.finalize = async (paths, dependencies) => {
      dependencies?.onProgress?.({ phase: 'derivative', percent: 34 });
      await blocked;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');
    expect(recorder.getFinalizationProgress('r1', 'scheduled')).toBeNull();
    await recorder.startRecording('r1');
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured');
    const stopping = recorder.stopRecording('r1');
    await flush();
    expect(state.records.get('r1')?.status).toBe('finalizing');
    expect(recorder.getFinalizationProgress('r1', 'finalizing')).toEqual({ phase: 'derivative', percent: 34 });
    expect(recorder.getFinalizationProgress('r1', 'cancelled')).toBeNull();
    release();
    await stopping;
    expect(recorder.getFinalizationProgress('r1', 'completed')).toBeNull();
    expect(recorder.getFinalizationProgress('r1', 'finalizing')).toBeNull();
  });

  it('directly cancelling a scheduled recording removes every unpublished artifact', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    for (const name of ['r1.segment-000000.ts.part', 'r1.ts.part', 'r1.mp4.part', 'r1.edl']) {
      fs.writeFileSync(path.join(nested, name), name);
    }
    state.rules.set('rule-1', rule());
    state.records.set('r1', recording({
      rule_id: 'rule-1', rule_revision: 1, program_start_time: 2_000, airing_key: 'a1',
    }));
    const recorder = await import('./recorder.js');

    await recorder.cancelRecording('r1');

    expect(state.records.get('r1')?.status).toBe('cancelled');
    expect(state.rules.get('rule-1')).toMatchObject({ cadence_retry_start: 2_000, cadence_retry_key: 'a1' });
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

  it('removes a completed VOD HLS package and interrupted staging without touching a sibling', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'r1.ts'), 'master');
    fs.writeFileSync(path.join(nested, 'r10.ts'), 'other master');
    for (const name of ['r1.hls', 'r1.hls.part-dead', 'r10.hls']) {
      fs.mkdirSync(path.join(nested, name));
      fs.writeFileSync(path.join(nested, name, 'segment-00000.ts'), name);
    }
    state.records.set('r1', recording({
      status: 'completed', file_path: '2026/09/20/r1.ts', master_file_path: '2026/09/20/r1.ts',
    }));
    const recorder = await import('./recorder.js');
    await recorder.deleteRecordingFile('r1');
    expect(fs.existsSync(path.join(nested, 'r1.hls'))).toBe(false);
    expect(fs.existsSync(path.join(nested, 'r1.hls.part-dead'))).toBe(false);
    expect(fs.existsSync(path.join(nested, 'r10.hls', 'segment-00000.ts'))).toBe(true);
  });

  it('retries a clean early EOF into a new segment and finalizes every attempt', async () => {
    state.rules.set('rule-1', rule({
      cadence_occurrence_progress: 3,
      cadence_cursor_start: 1_500,
      cadence_cursor_key: 'older',
      cadence_retry_start: 1_800,
      cadence_retry_key: 'failed',
    }));
    state.records.set('r1', recording({
      rule_id: 'rule-1', rule_revision: 1, program_start_time: 2_000,
    }));
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    finishCapture(0, 0);
    await flush();
    expect(state.records.get('r1')?.status).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.spawned).toHaveLength(2);
    expect(state.spawned[0].args[state.spawned[0].args.indexOf('-i') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/stream\/.*[?]subs=1$/);
    expect(state.spawned[0].args[state.spawned[0].args.indexOf('-i') + 1]).not.toContain('example.test');
    expect(state.spawned[0].args.at(-1)).toMatch(/r1\.segment-000000\.ts\.part$/);
    expect(state.spawned[1].args.at(-1)).toMatch(/r1\.segment-000001\.ts\.part$/);

    const stopped = recorder.stopRecording('r1');
    await stopped;

    expect(state.records.get('r1')).toMatchObject({ status: 'completed', duration: 30 });
    expect(state.rules.get('rule-1')).toMatchObject({
      cadence_last_success_start: 2_000,
      cadence_occurrence_progress: 0,
      cadence_cursor_start: 2_000,
      cadence_cursor_key: null,
      cadence_retry_start: null,
      cadence_retry_key: null,
    });
    expect(state.analysisNotifications).toBe(0);
    expect(state.records.get('r1')?.analysis_state).toBe('not_requested');
  });

  it('does not let an old rule revision advance the edited rule cadence', async () => {
    state.rules.set('rule-1', rule({ rule_revision: 2, cadence_last_success_start: 500 }));
    state.records.set('r1', recording({
      rule_id: 'rule-1', rule_revision: 1, program_start_time: 2_000,
    }));
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    await recorder.stopRecording('r1');

    expect(state.records.get('r1')?.status).toBe('completed');
    expect(state.rules.get('rule-1')?.cadence_last_success_start).toBe(500);
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

  it('serializes finalization so simultaneous recordings do not create an I/O spike', async () => {
    state.records.set('r1', recording());
    state.records.set('r2', recording({ id: 'r2' }));
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const finalizationIds: string[] = [];
    state.finalize = async paths => {
      finalizationIds.push(path.basename(paths.master, '.ts.part'));
      if (finalizationIds.length === 1) await firstBlocked;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    await recorder.startRecording('r2');
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured-1');
    fs.writeFileSync(state.spawned[1].args.at(-1)!, 'captured-2');
    const stoppingFirst = recorder.stopRecording('r1');
    const stoppingSecond = recorder.stopRecording('r2');
    await flush();
    const concurrentFinalizations = finalizationIds.length;
    releaseFirst();
    await Promise.all([stoppingFirst, stoppingSecond]);

    expect(concurrentFinalizations).toBe(1);
    expect(finalizationIds).toHaveLength(2);
  });

  it('cancels a queued finalization without waiting for an earlier remux', async () => {
    state.records.set('r1', recording());
    state.records.set('r2', recording({ id: 'r2' }));
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let finalizationCalls = 0;
    state.finalize = async paths => {
      finalizationCalls += 1;
      if (finalizationCalls === 1) await firstBlocked;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');

    await recorder.startRecording('r1');
    await recorder.startRecording('r2');
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured-1');
    fs.writeFileSync(state.spawned[1].args.at(-1)!, 'captured-2');
    const stoppingFirst = recorder.stopRecording('r1');
    await flush();
    const stoppingSecond = recorder.stopRecording('r2');
    await flush();
    expect(finalizationCalls).toBe(1);

    await recorder.cancelRecording('r2');

    expect(state.records.get('r2')?.status).toBe('cancelled');
    expect(recorder.isRecordingActive('r2')).toBe(false);
    expect(finalizationCalls).toBe(1);
    releaseFirst();
    await Promise.all([stoppingFirst, stoppingSecond]);
  });

  it('deletes only the oldest completed media when a rolling retention limit is exceeded', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    state.rules.set('rule-1', rule({ retention_count: 2 }));
    for (const [id, start] of [['oldest', 1_000], ['middle', 2_000], ['newest', 3_000]] as const) {
      const relativePath = `2026/09/20/${id}.ts`;
      fs.writeFileSync(path.join(recordingsDir, relativePath), id);
      state.records.set(id, recording({
        id, rule_id: 'rule-1', status: 'completed', start_time: start,
        master_file_path: relativePath, file_path: relativePath,
      }));
    }
    state.records.set('active', recording({ id: 'active', rule_id: 'rule-1', status: 'recording', start_time: 500 }));
    const recorder = await import('./recorder.js');

    await recorder.enforceRuleRetention('rule-1');

    expect(state.deleted).toEqual(['oldest']);
    expect(fs.existsSync(path.join(recordingsDir, '2026/09/20/oldest.ts'))).toBe(false);
    expect([...state.records.keys()].sort()).toEqual(['active', 'middle', 'newest']);
  });

  it('serializes rule policy changes behind an in-flight destructive prune', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    state.rules.set('rule-1', rule({ retention_count: 1 }));
    for (const [id, start] of [['oldest', 1_000], ['newest', 2_000]] as const) {
      const relativePath = `2026/09/20/${id}.ts`;
      fs.writeFileSync(path.join(recordingsDir, relativePath), id);
      state.records.set(id, recording({ id, rule_id: 'rule-1', status: 'completed', start_time: start, file_path: relativePath }));
    }
    let releaseAnalysis!: () => void;
    state.cancelAnalysis = () => new Promise<void>(resolve => { releaseAnalysis = resolve; });
    const recorder = await import('./recorder.js');

    const pruning = recorder.enforceRuleRetention('rule-1');
    await flush();
    let policyUpdated = false;
    const updating = recorder.withRuleRetentionLock('rule-1', () => {
      state.rules.set('rule-1', rule({ retention_count: 2 }));
      policyUpdated = true;
    });
    await flush();

    expect(policyUpdated).toBe(false);
    releaseAnalysis();
    await Promise.all([pruning, updating]);
    expect(policyUpdated).toBe(true);
  });

  it('keeps database metadata when verified retention media deletion fails', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    state.rules.set('rule-1', rule({ retention_count: 1 }));
    const oldRelative = '2026/09/20/oldest.ts';
    fs.writeFileSync(path.join(recordingsDir, oldRelative), 'oldest');
    state.records.set('oldest', recording({
      id: 'oldest', rule_id: 'rule-1', status: 'completed', start_time: 1_000, file_path: oldRelative,
    }));
    state.records.set('newest', recording({
      id: 'newest', rule_id: 'rule-1', status: 'completed', start_time: 2_000, file_path: 'newest.ts',
    }));
    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmDirOptions) => {
      if (String(target).endsWith('oldest.ts')) throw new Error('permission denied');
      return originalRmSync(target, options);
    }) as typeof fs.rmSync);
    const recorder = await import('./recorder.js');

    await expect(recorder.enforceRuleRetention('rule-1')).rejects.toThrow(/retention cleanup incomplete/i);

    expect(state.deleted).toEqual([]);
    expect(state.records.has('oldest')).toBe(true);
    rmSpy.mockRestore();
  });

  it('reconciles surplus scheduled airings when a rule changes to record once', async () => {
    state.rules.set('rule-1', rule({ airing_policy: 'once' }));
    state.records.set('first', recording({ id: 'first', rule_id: 'rule-1', status: 'scheduled', start_time: 1_000 }));
    state.records.set('second', recording({ id: 'second', rule_id: 'rule-1', status: 'scheduled', start_time: 2_000 }));
    state.records.set('third', recording({ id: 'third', rule_id: 'rule-1', status: 'scheduled', start_time: 3_000 }));
    const recorder = await import('./recorder.js');

    await recorder.reconcileRecordOnceRule('rule-1');

    expect(state.records.get('first')?.status).toBe('scheduled');
    expect(state.records.get('second')?.status).toBe('cancelled');
    expect(state.records.get('third')?.status).toBe('cancelled');
  });

  it('can evict a just-finalized older airing without awaiting its own finalizer', async () => {
    state.rules.set('rule-1', rule({ retention_count: 1 }));
    state.records.set('newer', recording({
      id: 'newer', rule_id: 'rule-1', status: 'completed', start_time: 3_000,
      file_path: 'newer.ts', master_file_path: 'newer.ts',
    }));
    state.records.set('older', recording({
      id: 'older', rule_id: 'rule-1', status: 'scheduled', start_time: 1_000,
    }));
    const recorder = await import('./recorder.js');

    await recorder.startRecording('older');
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured');
    await recorder.stopRecording('older');

    expect(state.deleted).toEqual(['older']);
    expect(state.records.has('newer')).toBe(true);
    expect(recorder.isRecordingActive('older')).toBe(false);
  });

  it('recovers legacy partial capture data and finalizes it after the recording window', async () => {
    const nested = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'r1.ts.part'), 'legacy');
    state.records.set('r1', recording({ status: 'recording', end_time: 5_000 }));
    const recorder = await import('./recorder.js');

    await recorder.recoverRecordings();
    await vi.waitFor(() => expect(state.records.get('r1')?.status).toBe('completed'));

    expect(state.records.get('r1')?.master_file_path).toMatch(/r1\.ts$/);
    expect(state.analysisNotifications).toBe(0);
    expect(state.records.get('r1')?.analysis_state).toBe('not_requested');
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

  it('defers live and expired captures for restart without entering finalization during shutdown', async () => {
    state.records.set('r1', recording({ end_time: 120_000 }));
    state.records.set('r2', recording({ id: 'r2', end_time: 120_000 }));
    let finalizationCalls = 0;
    state.finalize = async paths => {
      finalizationCalls += 1;
      fs.writeFileSync(paths.master, 'master');
      fs.writeFileSync(paths.derivative, 'mp4');
      return { durationSeconds: 30, masterSize: 6, derivativeSize: 3, derivativeError: null };
    };
    const recorder = await import('./recorder.js');
    await recorder.startRecording('r1');
    await recorder.startRecording('r2');
    state.records.set('r2', { ...state.records.get('r2')!, end_time: 5_000 });
    const futureCapturePath = state.spawned[0].args.at(-1)!;
    const expiredCapturePath = state.spawned[1].args.at(-1)!;
    fs.writeFileSync(futureCapturePath, 'partial-at-shutdown');
    fs.writeFileSync(expiredCapturePath, 'expired-at-shutdown');

    await recorder.stopAllRecordings();

    expect(state.records.get('r1')).toMatchObject({ status: 'scheduled', error: null });
    expect(state.records.get('r2')).toMatchObject({ status: 'finalizing', error: null });
    expect(fs.readFileSync(futureCapturePath, 'utf8')).toBe('partial-at-shutdown');
    expect(fs.readFileSync(expiredCapturePath, 'utf8')).toBe('expired-at-shutdown');
    expect(finalizationCalls).toBe(0);
    expect(state.analysisNotifications).toBe(0);
  });

  it('ignores an interrupted concat output when original capture segments are recoverable', async () => {
    vi.resetModules();
    const dir = path.join(recordingsDir, '2026', '09', '20');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of [
      ['r1.segment-000000.ts.part', 'first'],
      ['r1.segment-000001.ts.part', 'second'],
      ['r1.ts.part', 'first-partial-duplicate'],
    ]) fs.writeFileSync(path.join(dir, name), data);
    state.records.set('r1', recording({ status: 'finalizing', end_time: 5_000 }));
    let segments: string[] = [];
    state.finalize = async paths => {
      segments = paths.segments ?? [];
      fs.writeFileSync(paths.master, 'firstsecond');
      return { durationSeconds: 30, masterSize: 11, derivativeSize: 0, derivativeError: 'no derivative' };
    };
    const recorder = await import('./recorder.js');
    await recorder.recoverRecordings();
    await vi.waitFor(() => expect(state.records.get('r1')?.status).toBe('completed'));
    expect(segments.map(segment => path.basename(segment))).toEqual([
      'r1.segment-000000.ts.part', 'r1.segment-000001.ts.part',
    ]);
    expect(fs.existsSync(path.join(dir, 'r1.ts.part'))).toBe(false);
  });

  it('stops active captures before waiting for a stalled preflight and leaves the preflight restartable', async () => {
    vi.resetModules();
    const { resolveStreamUrl } = await import('./stream-utils.js');
    vi.mocked(resolveStreamUrl).mockResolvedValueOnce('https://example.test/live');
    state.records.set('active', recording({ id: 'active', end_time: 120_000 }));
    state.records.set('pending', recording({ id: 'pending', end_time: 120_000 }));
    const recorder = await import('./recorder.js');
    await recorder.startRecording('active');
    const activeCapture = state.spawned[0].process;
    fs.writeFileSync(state.spawned[0].args.at(-1)!, 'captured');
    let rejectPreflight!: (reason: Error) => void;
    vi.mocked(resolveStreamUrl).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPreflight = reject; }));
    const starting = recorder.startRecording('pending');
    await flush();
    const stopping = recorder.stopAllRecordings();
    await flush();
    expect(activeCapture.kill).toHaveBeenCalledWith('SIGINT');
    rejectPreflight(new Error('shutdown abort'));
    await Promise.all([starting, stopping]);
    expect(state.records.get('pending')?.status).toBe('scheduled');
    expect(state.records.get('pending')?.error).toBeNull();
  });
});

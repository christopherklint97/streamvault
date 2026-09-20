// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  COMSKIP_DETECTOR_VERSION,
  COMSKIP_PROFILE_VERSION,
  COMSKIP_TIMEOUT_MS,
  createCommercialAnalysisWorker,
  type CommercialWorkerDependencies,
  type QueuedAnalysisRecording,
} from './comskip-worker.js';

function recording(overrides: Partial<QueuedAnalysisRecording> = {}): QueuedAnalysisRecording {
  return {
    id: 'r1',
    master_file_path: '2026/09/r1.ts',
    duration: 120,
    status: 'completed',
    analysis_state: 'analyzing',
    ...overrides,
  };
}

function dependencies(overrides: Partial<CommercialWorkerDependencies> = {}) {
  const failures: Array<{ id: string; message: string }> = [];
  const completions: Array<{ id: string; segments: unknown[]; state: string }> = [];
  const deps: CommercialWorkerDependencies = {
    recoverStaleAnalysis: vi.fn(() => 0),
    claimNextQueuedAnalysis: vi.fn(() => recording()),
    failAnalysis: vi.fn((id, message) => { failures.push({ id, message }); return true; }),
    completeAnalysis: vi.fn((id, segments, state) => {
      completions.push({ id, segments, state });
      return true;
    }),
    readFile: vi.fn(() => '10 20 0\n30 45 0\n'),
    removeFile: vi.fn(),
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    binaryAvailable: vi.fn(() => true),
    canAnalyze: vi.fn(() => true),
    recordingsDir: '/recordings',
    binaryPath: '/usr/local/bin/comskip',
    profilePath: '/etc/comskip/espn.ini',
    now: vi.fn(() => 1000),
    ...overrides,
  };
  return { deps, failures, completions };
}

describe('Comskip analysis worker', () => {
  it('atomically claims queued work and completes detector output as one guarded update', async () => {
    const { deps, completions } = dependencies();
    const worker = createCommercialAnalysisWorker(deps, { pollIntervalMs: 60_000 });

    worker.start();
    await worker.runNext();
    await worker.stop();

    expect(deps.recoverStaleAnalysis).toHaveBeenCalledTimes(1);
    expect(deps.claimNextQueuedAnalysis).toHaveBeenCalledWith(1000);
    expect(deps.run).toHaveBeenCalledWith('/usr/local/bin/comskip', [
      '--ini=/etc/comskip/espn.ini', '--output=/recordings/2026/09', '/recordings/2026/09/r1.ts',
    ], expect.objectContaining({ timeoutMs: COMSKIP_TIMEOUT_MS, signal: expect.any(AbortSignal) }));
    expect(completions).toEqual([{
      id: 'r1',
      state: 'review_needed',
      segments: [
        { startSeconds: 10, endSeconds: 20, detector: 'comskip', confidence: null, detectorVersion: COMSKIP_DETECTOR_VERSION, reviewState: 'suggested' },
        { startSeconds: 30, endSeconds: 45, detector: 'comskip', confidence: null, detectorVersion: COMSKIP_DETECTOR_VERSION, reviewState: 'suggested' },
      ],
    }]);
    expect(deps.completeAnalysis).toHaveBeenCalledWith(
      'r1', expect.any(Array), 'review_needed', COMSKIP_PROFILE_VERSION, 1000,
    );
  });

  it('never replaces the last good map when Comskip or EDL validation fails', async () => {
    const { deps, failures } = dependencies({ readFile: vi.fn(() => '10 200 0\n') });
    const worker = createCommercialAnalysisWorker(deps);

    await worker.runNext();

    expect(deps.completeAnalysis).not.toHaveBeenCalled();
    expect(failures.at(-1)).toMatchObject({ id: 'r1', message: expect.stringMatching(/duration/i) });
  });

  it('marks claimed work failed clearly when the optional binary is unavailable', async () => {
    const { deps, failures } = dependencies({ binaryAvailable: vi.fn(() => false) });
    const worker = createCommercialAnalysisWorker(deps);

    expect(worker.isAvailable()).toBe(false);
    expect(await worker.runNext()).toBe(true);
    expect(deps.run).not.toHaveBeenCalled();
    expect(failures.at(-1)).toMatchObject({ id: 'r1', message: expect.stringMatching(/unavailable/i) });
  });

  it('runs at most one queued job at a time', async () => {
    let release!: () => void;
    const running = new Promise<void>(resolve => { release = resolve; });
    const { deps } = dependencies({
      run: vi.fn(async () => {
        await running;
        return { code: 0, stdout: '', stderr: '' };
      }),
    });
    const worker = createCommercialAnalysisWorker(deps);

    const first = worker.runNext();
    const second = worker.runNext();
    expect(await second).toBe(false);
    expect(deps.run).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('rejects claimed records without a completed master file', async () => {
    const { deps, failures } = dependencies({
      claimNextQueuedAnalysis: vi.fn(() => recording({ status: 'recording', master_file_path: null })),
    });
    const worker = createCommercialAnalysisWorker(deps);

    await worker.runNext();

    expect(deps.run).not.toHaveBeenCalled();
    expect(failures.at(-1)).toMatchObject({ id: 'r1', message: expect.stringMatching(/completed master/i) });
  });

  it('defers analysis while any capture or finalization is active', async () => {
    const { deps } = dependencies({ canAnalyze: vi.fn(() => false) });
    const worker = createCommercialAnalysisWorker(deps);

    expect(await worker.runNext()).toBe(false);
    expect(deps.claimNextQueuedAnalysis).not.toHaveBeenCalled();
  });

  it('aborts and awaits only the requested recording analysis before deletion', async () => {
    let observedSignal: AbortSignal | undefined;
    let processReleased = false;
    const { deps } = dependencies({
      run: vi.fn(async (_command, _args, options) => {
        observedSignal = options?.signal;
        await new Promise<void>(resolve => observedSignal?.addEventListener('abort', () => resolve(), { once: true }));
        processReleased = true;
        return { code: null, stdout: '', stderr: '', aborted: true };
      }),
    });
    const worker = createCommercialAnalysisWorker(deps);
    const active = worker.runNext();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await worker.cancelRecording('other');
    expect(observedSignal?.aborted).toBe(false);
    await worker.cancelRecording('r1');
    await active;

    expect(observedSignal?.aborted).toBe(true);
    expect(processReleased).toBe(true);
    expect(deps.completeAnalysis).not.toHaveBeenCalled();
    expect(deps.failAnalysis).not.toHaveBeenCalled();
  });

  it('aborts and awaits the active Comskip process when stopped', async () => {
    let observedSignal: AbortSignal | undefined;
    const { deps } = dependencies({
      run: vi.fn(async (_command, _args, options) => {
        observedSignal = options?.signal;
        await new Promise<void>(resolve => observedSignal?.addEventListener('abort', () => resolve(), { once: true }));
        return { code: null, stdout: '', stderr: '', aborted: true };
      }),
    });
    const worker = createCommercialAnalysisWorker(deps);

    const active = worker.runNext();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await worker.stop();
    await active;

    expect(observedSignal?.aborted).toBe(true);
    expect(deps.completeAnalysis).not.toHaveBeenCalled();
    expect(deps.failAnalysis).not.toHaveBeenCalled();
  });
});

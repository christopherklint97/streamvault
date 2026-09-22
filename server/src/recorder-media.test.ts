// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PROCESS_OUTPUT_TAIL_BYTES,
  buildDerivativeArgs,
  buildMasterConcatArgs,
  buildMasterCaptureArgs,
  buildCaptureSegmentPath,
  buildProbeDurationArgs,
  buildRecordingArtifactPaths,
  createOnceFinalizer,
  discoverCaptureSegments,
  discoverRecordingArtifacts,
  finalizeRecordingMedia,
  nextCaptureAttemptIndex,
  parseConfiguredConcurrency,
  runProcess,
  shouldRetryCapture,
} from './recorder-media.js';

describe('recording ffmpeg arguments', () => {
  it('stream-copies optional video, audio, and data streams into an MPEG-TS part file', () => {
    const args = buildMasterCaptureArgs('https://example.test/live', '/recordings/r1.ts.part', {
      'User-Agent': 'VLC',
    });
    expect(args).toEqual(expect.arrayContaining([
      '-i', 'https://example.test/live',
      '-map', '0:v:0?', '-map', '0:a?', '-map', '0:d?',
      '-c', 'copy', '-copy_unknown', '-f', 'mpegts', '-y', '/recordings/r1.ts.part',
    ]));
    expect(args).not.toContain('libx264');
    expect(args).toContain('User-Agent: VLC\r\n');
  });

  it('creates a seekable MP4 derivative with copied streams and normalized timestamps', () => {
    expect(buildDerivativeArgs('/recordings/r1.ts', '/recordings/r1.mp4.part')).toEqual([
      '-fflags', '+genpts', '-i', '/recordings/r1.ts',
      '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy',
      '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
      '-f', 'mp4', '-y', '/recordings/r1.mp4.part',
    ]);
    expect(buildProbeDurationArgs('/recordings/r1.ts')).toContain('/recordings/r1.ts');
  });
});

describe('recording media finalization', () => {
  it('remuxes every recovered attempt segment into one master before publishing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const firstPart = path.join(dir, 'r0.segment-000000.ts.part');
    const second = path.join(dir, 'r0.segment-000001.ts');
    const masterPart = path.join(dir, 'r0.ts.part');
    const master = path.join(dir, 'r0.ts');
    const derivativePart = path.join(dir, 'r0.mp4.part');
    const derivative = path.join(dir, 'r0.mp4');
    fs.writeFileSync(firstPart, 'first');
    fs.writeFileSync(second, 'second');
    const segments = discoverCaptureSegments(dir, 'r0');
    expect(segments).toEqual([firstPart, second]);
    const run = vi.fn(async (command: string, args: string[], _options?: unknown) => {
      if (command === 'ffmpeg' && args.includes(masterPart)) {
        fs.writeFileSync(masterPart, 'firstsecond');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'ffprobe') return { code: 0, stdout: '12', stderr: '' };
      fs.writeFileSync(derivativePart, 'mp4');
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await finalizeRecordingMedia({
      part: masterPart, master, derivativePart, derivative, segments,
    }, { run });

    expect(run).toHaveBeenCalledWith('ffmpeg', buildMasterConcatArgs(segments, masterPart), expect.any(Object));
    expect(run.mock.calls.every(([, , options]) => options?.backgroundPriority === true)).toBe(true);
    expect(fs.readFileSync(master, 'utf8')).toBe('firstsecond');
    expect(result.masterSize).toBe(11);
    expect(fs.existsSync(firstPart)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('promotes one capture segment without a full master remux', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const segment = path.join(dir, 'single.segment-000000.ts.part');
    const masterPart = path.join(dir, 'single.ts.part');
    const master = path.join(dir, 'single.ts');
    const derivativePart = path.join(dir, 'single.mp4.part');
    const derivative = path.join(dir, 'single.mp4');
    fs.writeFileSync(segment, 'captured-once');
    const sourceInode = fs.statSync(segment).ino;
    const run = vi.fn(async (command: string) => {
      if (command === 'ffprobe') return { code: 0, stdout: '30', stderr: '' };
      fs.writeFileSync(derivativePart, 'mp4');
      return { code: 0, stdout: '', stderr: '' };
    });

    await finalizeRecordingMedia({
      part: masterPart, master, derivativePart, derivative, segments: [segment],
    }, { run });

    expect(run.mock.calls.filter(([command]) => command === 'ffmpeg')).toHaveLength(1);
    expect(fs.statSync(master).ino).toBe(sourceInode);
    expect(fs.readFileSync(master, 'utf8')).toBe('captured-once');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomically publishes the master, probes duration, and publishes the derivative', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const part = path.join(dir, 'r1.ts.part');
    const master = path.join(dir, 'r1.ts');
    const derivativePart = path.join(dir, 'r1.mp4.part');
    const derivative = path.join(dir, 'r1.mp4');
    fs.writeFileSync(part, 'master');
    const run = vi.fn(async (command: string, _args: string[]) => {
      if (command === 'ffprobe') return { code: 0, stdout: '123.456\n', stderr: '' };
      fs.writeFileSync(derivativePart, 'mp4');
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await finalizeRecordingMedia({ part, master, derivativePart, derivative }, { run });

    expect(result).toMatchObject({ durationSeconds: 123, masterSize: 6, derivativeSize: 3, derivativeError: null });
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.readFileSync(master, 'utf8')).toBe('master');
    expect(fs.readFileSync(derivative, 'utf8')).toBe('mp4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('propagates cancellation instead of publishing an incomplete finalization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const master = path.join(dir, 'aborted.ts');
    const part = path.join(dir, 'aborted.ts.part');
    const derivativePart = path.join(dir, 'aborted.mp4.part');
    const derivative = path.join(dir, 'aborted.mp4');
    fs.writeFileSync(master, 'master');
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => ({
      code: null, stdout: '', stderr: '', signal: 'SIGTERM' as NodeJS.Signals, aborted: true,
    }));

    await expect(finalizeRecordingMedia(
      { part, master, derivativePart, derivative },
      { run, signal: controller.signal },
    )).rejects.toThrow(/aborted/i);

    expect(fs.existsSync(derivative)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the finalized master and reports derivative failure without publishing a partial MP4', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const part = path.join(dir, 'r2.ts.part');
    const master = path.join(dir, 'r2.ts');
    const derivativePart = path.join(dir, 'r2.mp4.part');
    const derivative = path.join(dir, 'r2.mp4');
    fs.writeFileSync(part, 'master');
    const run = vi.fn(async (command: string) => {
      if (command === 'ffprobe') return { code: 0, stdout: '61.8', stderr: '' };
      fs.writeFileSync(derivativePart, 'bad');
      return { code: 1, stdout: '', stderr: 'mux failed' };
    });

    const result = await finalizeRecordingMedia({ part, master, derivativePart, derivative }, { run });

    expect(result.durationSeconds).toBe(62);
    expect(result.derivativeError).toContain('mux failed');
    expect(fs.existsSync(master)).toBe(true);
    expect(fs.existsSync(derivativePart)).toBe(false);
    expect(fs.existsSync(derivative)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats an existing master as authoritative over leftover attempt segments during recovery', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const segment = path.join(dir, 'r3.segment-000001.ts.part');
    const part = path.join(dir, 'r3.ts.part');
    const master = path.join(dir, 'r3.ts');
    const derivativePart = path.join(dir, 'r3.mp4.part');
    const derivative = path.join(dir, 'r3.mp4');
    fs.writeFileSync(master, 'complete-master');
    fs.writeFileSync(segment, 'leftover-subset');
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ffprobe') return { code: 0, stdout: '20', stderr: '' };
      expect(args).not.toContain(part);
      fs.writeFileSync(derivativePart, 'mp4');
      return { code: 0, stdout: '', stderr: '' };
    });

    await finalizeRecordingMedia({ part, master, derivativePart, derivative, segments: [segment] }, { run });

    expect(fs.readFileSync(master, 'utf8')).toBe('complete-master');
    expect(fs.existsSync(segment)).toBe(false);
    expect(run).not.toHaveBeenCalledWith('ffmpeg', expect.arrayContaining([part]), expect.any(Object));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resumes derivative generation from an already-published recovered master', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-recorder-'));
    const part = path.join(dir, 'r3.ts.part');
    const master = path.join(dir, 'r3.ts');
    const derivativePart = path.join(dir, 'r3.mp4.part');
    const derivative = path.join(dir, 'r3.mp4');
    fs.writeFileSync(master, 'master');
    const run = vi.fn(async (command: string) => {
      if (command === 'ffprobe') return { code: 0, stdout: '20', stderr: '' };
      fs.writeFileSync(derivativePart, 'mp4');
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await finalizeRecordingMedia({ part, master, derivativePart, derivative }, { run });

    expect(result).toMatchObject({ durationSeconds: 20, masterSize: 6, derivativeSize: 3 });
    expect(fs.readFileSync(master, 'utf8')).toBe('master');
    expect(fs.readFileSync(derivative, 'utf8')).toBe('mp4');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('recording limits and retry accounting', () => {
  it('uses a fresh attempt-specific capture path after recovered segments', () => {
    expect(buildCaptureSegmentPath('/recordings/day', 'r1', 2)).toBe('/recordings/day/r1.segment-000002.ts.part');
    expect(nextCaptureAttemptIndex([
      '/old/r1.segment-000000.ts.part',
      '/old/r1.segment-000003.ts',
      '/old/r10.segment-999999.ts',
      '/old/r1.mp4.part',
    ], 'r1')).toBe(4);
  });

  it('uses a valid configured concurrency directly and safely falls back for invalid values', () => {
    expect(parseConfiguredConcurrency('7', 3)).toBe(7);
    expect(parseConfiguredConcurrency('9', 3)).toBe(8);
    expect(parseConfiguredConcurrency('0', 3)).toBe(3);
    expect(parseConfiguredConcurrency('oops', 3)).toBe(3);
  });

  it('allows only one retry while the recording window remains open', () => {
    expect(shouldRetryCapture(0, 1000, 2000)).toBe(true);
    expect(shouldRetryCapture(1, 1000, 2000)).toBe(false);
    expect(shouldRetryCapture(0, 2000, 2000)).toBe(false);
  });

  it('retries a clean early EOF while the recording window remains open', () => {
    expect(shouldRetryCapture(0, 1000, 2000, 0)).toBe(true);
    expect(shouldRetryCapture(0, 2000, 2000, 0)).toBe(false);
  });

  it('runs terminal finalization only once when error and close both arrive', async () => {
    const finalize = vi.fn(async () => 'done');
    const once = createOnceFinalizer(finalize);
    await Promise.all([once(), once()]);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe('recording artifact cleanup', () => {
  it('includes master, derivative, partial files, and Comskip sidecars without duplicates', () => {
    const files = buildRecordingArtifactPaths('/recordings', {
      file_path: '2026/09/r1.mp4',
      master_file_path: '2026/09/r1.ts',
      derivative_file_path: '2026/09/r1.mp4',
    });
    expect(files).toEqual(expect.arrayContaining([
      '/recordings/2026/09/r1.ts',
      '/recordings/2026/09/r1.ts.part',
      '/recordings/2026/09/r1.mp4',
      '/recordings/2026/09/r1.mp4.part',
      '/recordings/2026/09/r1.edl',
      '/recordings/2026/09/r1.log',
      '/recordings/2026/09/r1.txt',
      '/recordings/2026/09/r1.csv',
      '/recordings/2026/09/r1.logo.txt',
    ]));
    expect(new Set(files).size).toBe(files.length);
  });

  it('discovers attempt segments and derivatives left before database publication', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-artifacts-'));
    const nested = path.join(dir, '2026', '09', '20');
    fs.mkdirSync(nested, { recursive: true });
    for (const name of ['r1.segment-000000.ts', 'r1.segment-000001.ts.part', 'r1.mp4.part', 'r1.edl', 'r10.ts']) {
      fs.writeFileSync(path.join(nested, name), name);
    }
    expect(discoverRecordingArtifacts(dir, 'r1').map(file => path.basename(file)).sort()).toEqual([
      'r1.edl', 'r1.mp4.part', 'r1.segment-000000.ts', 'r1.segment-000001.ts.part',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('bounded cancellable child processes', () => {
  it('retains only bounded stdout and stderr tails', async () => {
    const script = `process.stdout.write('a'.repeat(${PROCESS_OUTPUT_TAIL_BYTES + 100}));process.stderr.write('b'.repeat(${PROCESS_OUTPUT_TAIL_BYTES + 200}))`;
    const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(PROCESS_OUTPUT_TAIL_BYTES);
    expect(result.stderr).toHaveLength(PROCESS_OUTPUT_TAIL_BYTES);
    expect(result.stdout).toBe('a'.repeat(PROCESS_OUTPUT_TAIL_BYTES));
  });

  it('terminates a process at its deadline', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 30,
      killGraceMs: 10,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('terminates a process when its AbortSignal is aborted', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      timeoutMs: 10_000,
      killGraceMs: 10,
    });
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
  });
});

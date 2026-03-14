import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecording, updateRecording, getRecordingsByStatus, getConfig } from './db.js';
import { resolveStreamUrl, VLC_HEADERS } from './stream-utils.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'recordings');

function getRecordingsDir(): string {
  return process.env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR;
}

interface ActiveRecording {
  id: string;
  process: ChildProcess;
  retried: boolean;
}

const activeRecordings = new Map<string, ActiveRecording>();
const MAX_CONCURRENT = 3;

export function getActiveCount(): number {
  return activeRecordings.size;
}

export function isRecordingActive(id: string): boolean {
  return activeRecordings.has(id);
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

/** Get total disk usage of recordings directory in bytes */
export function getRecordingsDiskUsage(): number {
  const dir = getRecordingsDir();
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

export async function startRecording(id: string): Promise<void> {
  const rec = getRecording(id);
  if (!rec) {
    logger.error(`Recording ${id} not found`);
    return;
  }

  if (activeRecordings.size >= MAX_CONCURRENT) {
    const maxConcurrent = parseInt(getConfig('max_concurrent_recordings', String(MAX_CONCURRENT)), 10);
    if (activeRecordings.size >= maxConcurrent) {
      updateRecording(id, { status: 'failed', error: `Max concurrent recordings (${maxConcurrent}) reached` });
      logger.error(`Recording ${id}: max concurrent recordings reached`);
      return;
    }
  }

  const recordingsDir = getRecordingsDir();
  fs.mkdirSync(recordingsDir, { recursive: true });

  // Check disk space (refuse if < 1GB free)
  const freeSpace = getFreeDiskSpace(recordingsDir);
  if (freeSpace < 1_073_741_824) {
    updateRecording(id, { status: 'failed', error: 'Insufficient disk space (< 1GB free)' });
    logger.error(`Recording ${id}: insufficient disk space (${(freeSpace / 1e9).toFixed(1)}GB free)`);
    return;
  }

  // Create date-based subdirectory
  const now = new Date();
  const dateDir = path.join(
    recordingsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dateDir, { recursive: true });

  const outputFile = path.join(dateDir, `${id}.ts`);
  const relPath = path.relative(recordingsDir, outputFile);

  let streamUrl: string;
  try {
    streamUrl = await resolveStreamUrl(rec.channel_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resolve stream URL';
    updateRecording(id, { status: 'failed', error: msg });
    logger.error(`Recording ${id}: ${msg}`);
    return;
  }

  logger.info(`Recording ${id}: starting ffmpeg for "${rec.title}" → ${relPath}`);

  const headerArgs: string[] = [];
  for (const [key, val] of Object.entries(VLC_HEADERS)) {
    headerArgs.push('-headers', `${key}: ${val}\r\n`);
  }

  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',
    ...headerArgs,
    '-i', streamUrl,
    '-c', 'copy',
    '-f', 'mpegts',
    '-y',
    outputFile,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const active: ActiveRecording = { id, process: ffmpeg, retried: false };
  activeRecordings.set(id, active);

  updateRecording(id, {
    status: 'recording',
    actual_start: Date.now(),
    file_path: relPath,
  });

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.debug(`ffmpeg [${id}]: ${line}`);
  });

  ffmpeg.on('close', (code) => {
    activeRecordings.delete(id);
    const recording = getRecording(id);
    if (!recording) return;

    if (recording.status === 'cancelled') {
      logger.info(`Recording ${id}: cancelled`);
      return;
    }

    // Check if we stopped it intentionally (status already set to completed)
    if (recording.status === 'completed') {
      logger.info(`Recording ${id}: completed`);
      return;
    }

    if (code === 0 || code === 255) {
      // Normal exit (255 = SIGINT)
      finishRecording(id, outputFile);
    } else {
      // Unexpected exit — retry once if still within time window
      const now = Date.now();
      if (!active.retried && now < recording.end_time) {
        logger.warn(`Recording ${id}: ffmpeg exited with code ${code}, retrying in 10s...`);
        active.retried = true;
        updateRecording(id, { status: 'scheduled' });
        setTimeout(() => startRecording(id), 10_000);
      } else {
        updateRecording(id, {
          status: 'failed',
          error: `ffmpeg exited with code ${code}`,
          actual_end: now,
        });
        logger.error(`Recording ${id}: ffmpeg failed with code ${code}`);
      }
    }
  });

  ffmpeg.on('error', (err) => {
    activeRecordings.delete(id);
    updateRecording(id, {
      status: 'failed',
      error: err.message,
      actual_end: Date.now(),
    });
    logger.error(`Recording ${id}: ffmpeg error: ${err.message}`);
  });
}

function finishRecording(id: string, outputFile: string): void {
  let fileSize = 0;
  let duration = 0;
  try {
    const stat = fs.statSync(outputFile);
    fileSize = stat.size;
  } catch { /* file may not exist */ }

  const rec = getRecording(id);
  if (rec?.actual_start) {
    duration = Math.round((Date.now() - rec.actual_start) / 1000);
  }

  updateRecording(id, {
    status: 'completed',
    actual_end: Date.now(),
    file_size: fileSize,
    duration,
  });
  logger.info(`Recording ${id}: completed (${(fileSize / 1e6).toFixed(1)}MB, ${duration}s)`);
}

export async function stopRecording(id: string): Promise<void> {
  const active = activeRecordings.get(id);
  if (!active) {
    logger.warn(`Recording ${id}: not active, cannot stop`);
    return;
  }

  logger.info(`Recording ${id}: stopping...`);

  // Send SIGINT for graceful stop
  active.process.kill('SIGINT');

  // Mark as completed before ffmpeg exits
  const rec = getRecording(id);
  const recordingsDir = getRecordingsDir();
  const outputFile = rec?.file_path ? path.join(recordingsDir, rec.file_path) : null;

  // Wait up to 10s for graceful exit, then SIGKILL
  const forceKillTimer = setTimeout(() => {
    if (activeRecordings.has(id)) {
      logger.warn(`Recording ${id}: force killing ffmpeg`);
      active.process.kill('SIGKILL');
    }
  }, 10_000);

  active.process.on('close', () => {
    clearTimeout(forceKillTimer);
    if (outputFile) finishRecording(id, outputFile);
    else updateRecording(id, { status: 'completed', actual_end: Date.now() });
  });
}

export async function cancelRecording(id: string, deleteFile = false): Promise<void> {
  updateRecording(id, { status: 'cancelled', actual_end: Date.now() });

  const active = activeRecordings.get(id);
  if (active) {
    active.process.kill('SIGKILL');
    activeRecordings.delete(id);
  }

  if (deleteFile) {
    const rec = getRecording(id);
    if (rec?.file_path) {
      const fullPath = path.join(getRecordingsDir(), rec.file_path);
      try { fs.unlinkSync(fullPath); } catch { /* ok */ }
    }
  }

  logger.info(`Recording ${id}: cancelled${deleteFile ? ' (file deleted)' : ''}`);
}

export function deleteRecordingFile(id: string): void {
  const rec = getRecording(id);
  if (rec?.file_path) {
    const fullPath = path.join(getRecordingsDir(), rec.file_path);
    try { fs.unlinkSync(fullPath); } catch { /* ok */ }
  }
}

/** Get full path for a recording file */
export function getRecordingFilePath(id: string): string | null {
  const rec = getRecording(id);
  if (!rec?.file_path) return null;
  const fullPath = path.join(getRecordingsDir(), rec.file_path);
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

/** Recover recordings that were active when the server stopped */
export async function recoverRecordings(): Promise<void> {
  const active = getRecordingsByStatus('recording');
  const now = Date.now();

  for (const rec of active) {
    if (now < rec.end_time) {
      logger.info(`Recovering recording ${rec.id}: "${rec.title}" (still within time window)`);
      updateRecording(rec.id, { status: 'scheduled' });
      // Will be picked up by scheduler on next tick
    } else {
      logger.warn(`Recording ${rec.id}: was active but past end time, marking failed`);
      updateRecording(rec.id, { status: 'failed', error: 'Server restarted after end time', actual_end: now });
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  claimNextQueuedAnalysis,
  completeCommercialAnalysis,
  failCommercialAnalysis,
  recoverStaleCommercialAnalysis,
} from './db.js';
import { getActiveCount } from './recorder.js';
import { createCommercialAnalysisWorker } from './comskip-worker.js';
import { runProcess } from './recorder-media.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordingsDir = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'data', 'recordings');
const binaryPath = process.env.COMSKIP_PATH || '/usr/local/bin/comskip';
const bundledProfile = path.join(__dirname, '..', 'config', 'comskip', 'espn.ini');
const profilePath = process.env.COMSKIP_PROFILE || (fs.existsSync('/etc/comskip/espn.ini')
  ? '/etc/comskip/espn.ini'
  : bundledProfile);

function executableAvailable(command: string): boolean {
  if (!fs.existsSync(profilePath)) return false;
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync(command, ['--help'], { stdio: 'ignore' });
  return !result.error;
}

const commercialAnalysisWorker = createCommercialAnalysisWorker({
  recoverStaleAnalysis: recoverStaleCommercialAnalysis,
  claimNextQueuedAnalysis,
  failAnalysis: failCommercialAnalysis,
  completeAnalysis: completeCommercialAnalysis,
  readFile: filePath => fs.readFileSync(filePath, 'utf8'),
  removeFile: filePath => fs.rmSync(filePath, { force: true }),
  run: runProcess,
  binaryAvailable: executableAvailable,
  canAnalyze: () => getActiveCount() === 0,
  recordingsDir,
  binaryPath,
  profilePath,
  now: Date.now,
});

export function startCommercialAnalysisWorker(): void {
  if (!commercialAnalysisWorker.isAvailable()) {
    logger.warn(`Comskip unavailable; commercial analysis requests will fail clearly (${binaryPath}, ${profilePath})`);
  }
  commercialAnalysisWorker.start();
  commercialAnalysisWorker.notify();
}

export function stopCommercialAnalysisWorker(): Promise<void> {
  return commercialAnalysisWorker.stop();
}

export function notifyCommercialAnalysisQueued(): void {
  commercialAnalysisWorker.notify();
}

export function cancelCommercialAnalysis(recordingId: string): Promise<void> {
  return commercialAnalysisWorker.cancelRecording(recordingId);
}

export function isCommercialAnalysisAvailable(): boolean {
  return commercialAnalysisWorker.isAvailable();
}

export const commercialAnalysisPaths = { binaryPath, profilePath };

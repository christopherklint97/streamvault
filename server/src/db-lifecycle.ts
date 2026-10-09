import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processEntrypoint } from './process-entry.js';

const REQUIRED_TABLES = ['channels', 'categories', 'programs', 'config'] as const;

export interface DatabaseValidation {
  ok: boolean;
  error?: string;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateOpenDatabase(db: InstanceType<typeof Database>): DatabaseValidation {
  try {
    const result = db.pragma('quick_check') as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0]?.quick_check !== 'ok') {
      return { ok: false, error: `quick_check returned: ${JSON.stringify(result)}` };
    }

    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(', ')})`
    ).all(...REQUIRED_TABLES) as Array<{ name: string }>;
    const found = new Set(rows.map(row => row.name));
    const missing = REQUIRED_TABLES.filter(table => !found.has(table));
    if (missing.length > 0) {
      return { ok: false, error: `Missing required table(s): ${missing.join(', ')}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateDatabaseFile(file: string): DatabaseValidation {
  if (!fs.existsSync(file)) return { ok: false, error: 'Database file does not exist' };
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) return { ok: false, error: 'Database file is empty' };

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return validateOpenDatabase(db);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch { /* ignore close errors during validation */ }
  }
}

export function createAtomicBackup(db: InstanceType<typeof Database>, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const marker = `${target}.complete`;
  const markerTemp = `${marker}.tmp-${process.pid}-${Date.now()}`;
  try {
    db.exec(`VACUUM INTO ${quoteSqlString(temp)}`);
    const validation = validateDatabaseFile(temp);
    if (!validation.ok) throw new Error(`Backup validation failed: ${validation.error}`);
    fs.renameSync(temp, target);
    fs.writeFileSync(markerTemp, 'validated\n', { mode: 0o600 });
    fs.renameSync(markerTemp, marker);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* temp may not have been created */ }
    try { fs.unlinkSync(markerTemp); } catch { /* marker may already be published */ }
    throw error;
  }
}

export function findLatestValidBackup(backupDir: string): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const candidates = fs.readdirSync(backupDir)
    .filter(file => /^streamvault-\d{4}-\d{2}-\d{2}\.db$/.test(file))
    .map(file => path.join(backupDir, file))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  for (const candidate of candidates) {
    if (validateDatabaseFile(candidate).ok) return candidate;
  }
  return null;
}

/** Cheap due check: only atomic markers published after full validation count. */
export function isDatabaseBackupDue(backupDir: string, maxAgeMs: number, now = Date.now()): boolean {
  if (!fs.existsSync(backupDir)) return true;
  let names: string[];
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return true;
  }

  let newestMtime = 0;
  for (const name of names) {
    if (!/^streamvault-\d{4}-\d{2}-\d{2}\.db\.complete$/.test(name)) continue;
    try {
      const marker = fs.statSync(path.join(backupDir, name));
      const snapshot = fs.statSync(path.join(backupDir, name.slice(0, -'.complete'.length)));
      if (marker.isFile() && snapshot.isFile() && snapshot.size > 0) {
        newestMtime = Math.max(newestMtime, marker.mtimeMs);
      }
    } catch { /* missing/incomplete backup artifacts do not count */ }
  }
  return newestMtime === 0 || now - newestMtime >= maxAgeMs;
}

export function restoreLatestValidBackup(destination: string, backupDir: string): string | null {
  const source = findLatestValidBackup(backupDir);
  if (!source) return null;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.restore-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(source, temp);
    const validation = validateDatabaseFile(temp);
    if (!validation.ok) throw new Error(`Restored backup validation failed: ${validation.error}`);
    fs.renameSync(temp, destination);
    return source;
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

export function isDatabaseCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'SQLITE_CORRUPT' || /database disk image is malformed/i.test(error.message);
}

// Routine liveness must not scan every page on the HTTP event loop.
// Full integrity checks still run at startup and on backup snapshots.
export function checkDatabaseReadable(db: InstanceType<typeof Database>): DatabaseValidation {
  try {
    for (const table of REQUIRED_TABLES) db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function removeBackupFile(file: string, warnings: string[]): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    warnings.push(`Failed to remove backup ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    fs.unlinkSync(`${file}.complete`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Failed to remove backup marker ${path.basename(file)}.complete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function pruneDatabaseBackups(backupDir: string, retention = 7): string[] {
  const warnings: string[] = [];
  if (!fs.existsSync(backupDir)) return warnings;
  const names = fs.readdirSync(backupDir);
  for (const name of names) {
    if (/^streamvault-\d{4}-\d{2}-\d{2}\.db\.tmp-\d+-\d+$/.test(name)) {
      removeBackupFile(path.join(backupDir, name), warnings);
    }
  }
  const valid: string[] = [];
  const files = names
    .filter(name => /^streamvault-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse();

  for (const name of files) {
    const file = path.join(backupDir, name);
    if (validateDatabaseFile(file).ok) valid.push(file);
    else removeBackupFile(file, warnings);
  }
  for (const file of valid.slice(Math.max(0, retention))) removeBackupFile(file, warnings);
  return warnings;
}

function cleanupBackupTempFiles(backupDir: string): string[] {
  const warnings: string[] = [];
  if (!fs.existsSync(backupDir)) return warnings;
  let names: string[];
  try {
    names = fs.readdirSync(backupDir);
  } catch (error) {
    warnings.push(`Failed to inspect backup directory ${backupDir}: ${error instanceof Error ? error.message : String(error)}`);
    return warnings;
  }
  for (const name of names) {
    if (/^streamvault-\d{4}-\d{2}-\d{2}\.db\.tmp-\d+-\d+$/.test(name)) {
      removeBackupFile(path.join(backupDir, name), warnings);
    }
  }
  return warnings;
}

interface ActiveBackupWorker {
  child: ChildProcess;
  exited: Promise<void>;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
}

let activeBackupWorker: ActiveBackupWorker | null = null;

function requestBackupWorkerStop(active: ActiveBackupWorker): void {
  const { child } = active;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* force-kill timer remains armed */ }
  if (active.forceKillTimer) return;
  active.forceKillTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch { /* shutdown deadline remains the final guard */ }
  }, 2_000);
  active.forceKillTimer.unref();
}

export function backupDatabaseInWorker(
  source: string,
  backupDir: string,
  onWarning?: (warning: string) => void,
): Promise<string> {
  if (activeBackupWorker) return Promise.reject(new Error('Database backup already in progress'));
  return new Promise((resolve, reject) => {
    const entry = processEntrypoint('db-backup-worker', import.meta.url);
    const workerPath = fileURLToPath(entry.url);
    const child = fork(workerPath, [source, backupDir], {
      cwd: path.dirname(workerPath),
      execArgv: entry.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let finishExit!: () => void;
    const exited = new Promise<void>(finish => { finishExit = finish; });
    const active: ActiveBackupWorker = { child, exited, forceKillTimer: null };
    activeBackupWorker = active;
    let result: { target?: string; error?: string } | undefined;
    let terminalError: Error | undefined;
    const reportWarning = (warning: string): void => {
      try { onWarning?.(warning); } catch { /* warning handlers must not block settlement */ }
    };
    const timer = setTimeout(() => {
      terminalError = new Error('Database backup exceeded 15 minutes');
      requestBackupWorkerStop(active);
    }, 15 * 60 * 1000);
    timer.unref();
    child.on('message', message => {
      const workerMessage = message as { target?: string; error?: string; warning?: string };
      if (workerMessage.warning) reportWarning(workerMessage.warning);
      else result = workerMessage;
    });
    child.on('error', error => {
      terminalError ??= error;
    });
    child.once('close', (code, signal) => {
      let cleanupError: Error | undefined;
      try {
        for (const warning of cleanupBackupTempFiles(backupDir)) reportWarning(warning);
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timer);
        if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
        if (activeBackupWorker?.child === child) activeBackupWorker = null;
        finishExit();
      }
      if (!terminalError && !cleanupError && code === 0 && result?.target) resolve(result.target);
      else reject(terminalError || cleanupError || new Error(result?.error || `Backup worker exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    });
  });
}

export async function stopDatabaseBackupWorker(): Promise<void> {
  const active = activeBackupWorker;
  if (!active) return;
  requestBackupWorkerStop(active);
  await active.exited;
}

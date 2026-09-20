// @vitest-environment node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  backupDatabaseInWorker,
  checkDatabaseReadable,
  createAtomicBackup,
  findLatestValidBackup,
  isDatabaseBackupDue,
  pruneDatabaseBackups,
  restoreLatestValidBackup,
  stopDatabaseBackupWorker,
  validateDatabaseFile,
} from './db-lifecycle.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-db-'));
}

function createDb(file: string, marker: string): InstanceType<typeof Database> {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY);
    CREATE TABLE categories (id TEXT PRIMARY KEY);
    CREATE TABLE programs (id INTEGER PRIMARY KEY);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('marker', marker);
  return db;
}

function readMarker(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT value FROM config WHERE key = 'marker'").get() as { value: string }).value;
  } finally {
    db.close();
  }
}

test('atomic backups replace the same-day file only after a valid backup is ready', () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'backup.db');
  const db = createDb(source, 'first');

  createAtomicBackup(db, target);
  assert.equal(readMarker(target), 'first');
  assert.equal(fs.existsSync(`${target}.complete`), true);

  db.prepare("UPDATE config SET value = 'second' WHERE key = 'marker'").run();
  createAtomicBackup(db, target);
  assert.equal(readMarker(target), 'second');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed backup does not destroy the previous valid backup', () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'backup.db');
  const db = createDb(source, 'preserved');
  createAtomicBackup(db, target);
  db.close();

  assert.throws(() => createAtomicBackup(db, target));
  assert.equal(readMarker(target), 'preserved');
  assert.equal(validateDatabaseFile(target).ok, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('recovery skips empty or corrupt recent backups and restores the newest valid one', () => {
  const dir = tempDir();
  const backups = path.join(dir, 'backups');
  const destination = path.join(dir, 'streamvault.db');
  fs.mkdirSync(backups);

  const older = path.join(backups, 'streamvault-2026-07-22.db');
  createDb(older, 'valid').close();
  fs.writeFileSync(path.join(backups, 'streamvault-2026-07-23.db'), 'not sqlite');
  fs.writeFileSync(path.join(backups, 'streamvault-2026-07-24.db'), '');

  assert.equal(path.basename(findLatestValidBackup(backups)!), path.basename(older));
  assert.equal(restoreLatestValidBackup(destination, backups), older);
  assert.equal(readMarker(destination), 'valid');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup due check trusts only validated completion markers and avoids restart rewrites', () => {
  const dir = tempDir();
  const now = Date.parse('2026-09-17T12:00:00Z');
  const recent = path.join(dir, 'streamvault-2026-09-17.db');
  fs.writeFileSync(recent, 'not a completed SQLite backup');
  fs.utimesSync(recent, new Date(now - 60_000), new Date(now - 60_000));

  assert.equal(isDatabaseBackupDue(dir, 24 * 60 * 60 * 1000, now), true);

  const source = path.join(dir, 'source.db');
  const db = createDb(source, 'completed');
  createAtomicBackup(db, recent);
  db.close();
  fs.utimesSync(recent, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(`${recent}.complete`, new Date(now - 60_000), new Date(now - 60_000));

  assert.equal(isDatabaseBackupDue(dir, 24 * 60 * 60 * 1000, now), false);
  assert.equal(isDatabaseBackupDue(dir, 30_000, now), true);
  assert.equal(isDatabaseBackupDue(path.join(dir, 'missing'), 1, now), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup due check treats an unreadable backup path as due instead of crashing', () => {
  const dir = tempDir();
  const notDirectory = path.join(dir, 'not-a-directory');
  fs.writeFileSync(notDirectory, 'file');
  assert.equal(isDatabaseBackupDue(notDirectory, 1), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validation rejects an empty SQLite file with no StreamVault schema', () => {
  const dir = tempDir();
  const empty = path.join(dir, 'empty.db');
  new Database(empty).close();

  const result = validateDatabaseFile(empty);
  assert.equal(result.ok, false);
  assert.match(result.error || '', /(empty|missing required table)/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('routine health reads schema tables without running an integrity scan', () => {
  const dir = tempDir();
  const db = createDb(path.join(dir, 'source.db'), 'healthy');
  db.pragma = (() => { throw new Error('full scans forbidden in health check'); }) as typeof db.pragma;
  assert.equal(checkDatabaseReadable(db).ok, true);
  db.exec('DROP TABLE channels');
  assert.equal(checkDatabaseReadable(db).ok, false);
  db.close();
  assert.equal(checkDatabaseReadable(db).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup worker preserves data and reports failures without replacing a good snapshot', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.db');
  createDb(source, 'worker-backup').close();
  const target = await backupDatabaseInWorker(source, path.join(dir, 'backups'));
  assert.equal(readMarker(target), 'worker-backup');
  await assert.rejects(backupDatabaseInWorker(path.join(dir, 'missing.db'), path.join(dir, 'backups')));
  assert.equal(readMarker(target), 'worker-backup');
  fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

test('backup retention removes invalid snapshots and keeps seven valid snapshots', () => {
  const dir = tempDir();
  for (let day = 1; day <= 8; day++) {
    const date = `2026-01-${String(day).padStart(2, '0')}`;
    const snapshot = path.join(dir, `streamvault-${date}.db`);
    createDb(snapshot, date).close();
    fs.writeFileSync(`${snapshot}.complete`, 'validated\n');
  }
  const invalid = path.join(dir, 'streamvault-2026-01-09.db');
  const abandonedTemp = path.join(dir, 'streamvault-2026-01-10.db.tmp-123-456');
  fs.writeFileSync(invalid, 'not sqlite');
  fs.writeFileSync(`${invalid}.complete`, 'validated\n');
  fs.writeFileSync(abandonedTemp, 'partial snapshot');

  const warnings = pruneDatabaseBackups(dir);

  assert.deepEqual(warnings, []);
  assert.equal(fs.existsSync(invalid), false);
  assert.equal(fs.existsSync(abandonedTemp), false);
  const retained = fs.readdirSync(dir).filter(name => /^streamvault-.*\.db$/.test(name));
  const retainedMarkers = fs.readdirSync(dir).filter(name => /^streamvault-.*\.db\.complete$/.test(name));
  assert.equal(retained.length, 7);
  assert.equal(retainedMarkers.length, 7);
  assert.equal(retained.includes('streamvault-2026-01-01.db'), false);
  assert.equal(fs.existsSync(`${invalid}.complete`), false);
  fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

test('backup retention reports an unlink failure without failing the completed backup', () => {
  const dir = tempDir();
  const invalid = path.join(dir, 'streamvault-2026-01-01.db');
  fs.writeFileSync(invalid, 'not sqlite');
  const realUnlink = fs.unlinkSync;
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (file === invalid) throw new Error('read-only filesystem');
    return realUnlink(file);
  });

  try {
    const warnings = pruneDatabaseBackups(dir);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] || '', /read-only filesystem/);
    assert.equal(fs.existsSync(invalid), true);
  } finally {
    unlink.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid backup directory rejects without leaving the worker active', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.db');
  const notDirectory = path.join(dir, 'not-a-directory');
  createDb(source, 'invalid-backup-dir').close();
  fs.writeFileSync(notDirectory, 'file');

  await assert.rejects(backupDatabaseInWorker(source, notDirectory));
  const target = await backupDatabaseInWorker(source, path.join(dir, 'backups'));

  assert.equal(readMarker(target), 'invalid-backup-dir');
  fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

test('stopping the active backup worker waits for exit and removes temporary snapshots', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.db');
  const backups = path.join(dir, 'backups');
  createDb(source, 'stop-worker').close();
  const outcome = backupDatabaseInWorker(source, backups).then(
    target => ({ target }),
    error => ({ error: error as Error }),
  );

  await stopDatabaseBackupWorker();
  const result = await outcome;

  assert.ok('error' in result);
  const leftovers = fs.existsSync(backups)
    ? fs.readdirSync(backups).filter(name => name.includes('.tmp-'))
    : [];
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

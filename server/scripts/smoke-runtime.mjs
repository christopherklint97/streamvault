// Exercise the emitted package, not Vitest's TypeScript loader.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
for (const name of ['index.js', 'channel-read-thread.js', 'category-write-thread.js', 'epg-read-thread.js', 'epg-write-thread.js', 'db-backup-worker.js', 'live_packet_worker.py', 'live_packet_stitch.py']) {
  assert.ok(fs.existsSync(path.join(dist, name)), `Missing packaged runtime entry: ${name}`);
}
assert.ok(!fs.readdirSync(dist).some(name => /\.test\.|^test_/.test(name)), 'Tests must not ship in dist');
assert.ok(!process.execArgv.some(arg => /tsx/.test(arg)), 'Smoke must run without the tsx loader');
if (process.env.STREAMVAULT_ASSERT_PRODUCTION === '1') {
  const require = createRequire(import.meta.url);
  for (const name of ['tsx', 'esbuild', 'typescript', 'vitest']) {
    assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' }, `Development package shipped: ${name}`);
  }
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-runtime-'));
const dbPath = path.join(fixture, 'fixture.db');
const db = new Database(dbPath);
const workers = [];
let deadline;
try {
  db.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, url TEXT, logo TEXT, grp TEXT, region TEXT, content_type TEXT, category_id TEXT, sort_order INTEGER, added INTEGER, epg_channel_id TEXT);
    CREATE TABLE categories (id TEXT PRIMARY KEY, fetched_at INTEGER, stream_count INTEGER);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO config VALUES ('input_mode', 'xtream'), ('catalog_generation', 'first');
    INSERT INTO categories VALUES ('uk', 0, 0);
    CREATE TABLE programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', start_time INTEGER NOT NULL, stop_time INTEGER NOT NULL, category TEXT DEFAULT '');
    CREATE TABLE recordings (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, file_path TEXT, file_size INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, error TEXT, rule_id TEXT, program_title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE recording_rules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, match_title TEXT NOT NULL, match_type TEXT NOT NULL, enabled INTEGER NOT NULL, padding_before INTEGER NOT NULL, padding_after INTEGER NOT NULL, max_recordings INTEGER NOT NULL, created_at INTEGER NOT NULL);
  `);
  const { ensureRecordingSchema } = await import('../dist/db-migrations.js');
  ensureRecordingSchema(db);
  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO config VALUES (?, ?)').run('rolled-back', 'yes');
    throw new Error('rollback fixture');
  });
  assert.throws(transaction, /rollback fixture/);
  assert.equal(db.prepare("SELECT value FROM config WHERE key = 'rolled-back'").get(), undefined);

  const run = async () => {
    const { createCategoryWriteWorker } = await import('../dist/category-write-worker.js');
    const category = createCategoryWriteWorker(dbPath); workers.push(category);
    await category.save('uk', [{ id: 'one', name: 'One', url: 'https://example.test/live', logo: '', grp: 'UK', region: 'UK', content_type: 'livetv' }], 'first');
    assert.deepEqual(db.prepare('SELECT id FROM channels').all(), [{ id: 'one' }]);
    await assert.rejects(category.save('uk', [], 'stale'), /generation/i);
    const { createChannelReadWorker } = await import('../dist/channel-read-worker.js');
    const channel = createChannelReadWorker(dbPath); workers.push(channel);
    assert.equal((await channel.byIds(['one']))[0].name, 'One');

    const { createEpgWriteWorker } = await import('../dist/epg-write-worker.js');
    const writer = createEpgWriteWorker(dbPath); workers.push(writer);
    await writer.save([{ channel_id: 'one', title: 'News', description: '', start_time: 100, stop_time: 200, category: '', airing_key: 'one-news' }]);
    const { createEpgReadWorker } = await import('../dist/epg-read-worker.js');
    const reader = createEpgReadWorker(dbPath); workers.push(reader);
    assert.equal((await reader.read(['one'], 110, 180))[0].title, 'News');

    const { backupDatabaseInWorker, validateDatabaseFile, stopDatabaseBackupWorker } = await import('../dist/db-lifecycle.js');
    try {
      const backup = await backupDatabaseInWorker(dbPath, path.join(fixture, 'backups'));
      assert.deepEqual(validateDatabaseFile(backup), { ok: true });
      assert.ok(fs.existsSync(backup + '.complete'));
      await assert.rejects(backupDatabaseInWorker(path.join(fixture, 'missing.db'), path.join(fixture, 'failed-backups')));
    } finally {
      await stopDatabaseBackupWorker();
    }
  };
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Emitted runtime smoke exceeded 30 seconds')), 30_000); })]);
  console.log(JSON.stringify({ ok: true, compiledWorkers: 4, backupFork: true, backupFailure: true, nativeRollback: true, pythonSidecars: true }));
} finally {
  clearTimeout(deadline);
  await Promise.allSettled(workers.map(worker => worker.close()));
  db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}

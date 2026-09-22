// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureRecordingSchema } from './db-migrations.js';
import { createProgramStore, type ProgramSnapshotRow } from './program-store.js';

function database(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', start_time INTEGER NOT NULL, stop_time INTEGER NOT NULL, category TEXT DEFAULT '');
    CREATE TABLE recordings (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, file_path TEXT, file_size INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, error TEXT, rule_id TEXT, program_title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE recording_rules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, match_title TEXT NOT NULL, match_type TEXT NOT NULL, enabled INTEGER NOT NULL, padding_before INTEGER NOT NULL, padding_after INTEGER NOT NULL, max_recordings INTEGER NOT NULL, created_at INTEGER NOT NULL);
  `);
  ensureRecordingSchema(db);
  return db;
}

function program(overrides: Partial<ProgramSnapshotRow> = {}): ProgramSnapshotRow {
  return {
    channel_id: 'c1', title: 'Show', description: '', start_time: 100, stop_time: 200,
    category: '', source: 'xtream', source_channel_id: 'c1', airing_key: 'airing-1',
    ...overrides,
  };
}

describe('EPG snapshot reconciliation', () => {
  it('updates stable airings in place while preserving first_seen and incrementing revision only for changes', () => {
    const db = database();
    const store = createProgramStore(db);
    store.saveSnapshot([program()], 1_000);
    const first = db.prepare('SELECT id,first_seen,last_seen,schedule_revision FROM programs').get() as Record<string, number>;

    store.saveSnapshot([program({ start_time: 150, stop_time: 250 })], 2_000);
    const moved = db.prepare('SELECT id,first_seen,last_seen,schedule_revision,start_time FROM programs').get() as Record<string, number>;
    expect(moved).toMatchObject({ id: first.id, first_seen: 1_000, last_seen: 2_000, schedule_revision: first.schedule_revision + 1, start_time: 150 });

    store.saveSnapshot([program({ start_time: 150, stop_time: 250 })], 3_000);
    const unchanged = db.prepare('SELECT first_seen,last_seen,schedule_revision FROM programs').get() as Record<string, number>;
    expect(unchanged).toEqual({ first_seen: 1_000, last_seen: 3_000, schedule_revision: moved.schedule_revision });
    db.close();
  });

  it('refreshes unchanged airings without rewriting all guide fields', () => {
    const db = database();
    const store = createProgramStore(db);
    store.saveSnapshot([program()], 1_000);
    db.exec(`
      CREATE TABLE full_program_update_audit (count INTEGER NOT NULL);
      INSERT INTO full_program_update_audit VALUES (0);
      CREATE TRIGGER audit_full_program_update
      BEFORE UPDATE OF title, description, start_time, stop_time, category, source,
        source_channel_id, provider_event_id, provider_epg_id, subtitle,
        episode_numbers_json, is_repeat, is_new, is_live, original_air_date,
        raw_metadata, airing_key, content_key, categories_json, timezone
      ON programs
      BEGIN
        UPDATE full_program_update_audit SET count = count + 1;
      END;
    `);

    store.saveSnapshot([program()], 2_000);

    expect(db.prepare('SELECT count FROM full_program_update_audit').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT last_seen FROM programs').get()).toEqual({ last_seen: 2_000 });
    db.close();
  });

  it('does not erase cached guide data for an empty or failed snapshot', () => {
    const db = database();
    const store = createProgramStore(db);
    store.saveSnapshot([program()], 1_000);
    store.saveSnapshot([], 2_000);
    expect(db.prepare('SELECT title FROM programs').all()).toEqual([{ title: 'Show' }]);
    db.close();
  });

  it('keeps separate programs that do not have a usable airing key', () => {
    const db = database();
    const store = createProgramStore(db);

    store.saveSnapshot([
      program({ airing_key: '', title: 'First', start_time: 100, stop_time: 200 }),
      program({ airing_key: '', title: 'Second', start_time: 200, stop_time: 300 }),
    ], 1_000, ['c1']);

    expect(db.prepare('SELECT title FROM programs ORDER BY start_time').all()).toEqual([
      { title: 'First' },
      { title: 'Second' },
    ]);
    db.close();
  });

  it('removes stale rows for an explicitly completed empty channel snapshot', () => {
    const db = database();
    const store = createProgramStore(db);
    store.saveSnapshot([
      program(),
      program({ channel_id: 'c2', source_channel_id: 'c2', airing_key: 'airing-2', title: 'Other' }),
    ], 1_000);

    store.saveSnapshot([], 2_000, ['c1']);

    expect(db.prepare('SELECT channel_id,title FROM programs ORDER BY channel_id').all()).toEqual([
      { channel_id: 'c2', title: 'Other' },
    ]);
    db.close();
  });

  it('removes stale rows only inside channels in a completed scoped snapshot', () => {
    const db = database();
    const store = createProgramStore(db);
    store.saveSnapshot([
      program(),
      program({ channel_id: 'c2', source_channel_id: 'c2', airing_key: 'airing-2', title: 'Other' }),
    ], 1_000);
    store.saveSnapshot([program({ airing_key: 'airing-new', title: 'Replacement' })], 2_000, ['c1']);
    expect(db.prepare('SELECT channel_id,title FROM programs ORDER BY channel_id').all()).toEqual([
      { channel_id: 'c1', title: 'Replacement' }, { channel_id: 'c2', title: 'Other' },
    ]);
    db.close();
  });
});

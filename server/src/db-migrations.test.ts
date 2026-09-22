// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureRecordingSchema } from './db-migrations.js';

function oldDatabase(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', start_time INTEGER NOT NULL, stop_time INTEGER NOT NULL, category TEXT DEFAULT '');
    CREATE TABLE recordings (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, file_path TEXT, file_size INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, error TEXT, rule_id TEXT, program_title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE recording_rules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, match_title TEXT NOT NULL, match_type TEXT NOT NULL DEFAULT 'contains', enabled INTEGER NOT NULL DEFAULT 1, padding_before INTEGER NOT NULL DEFAULT 120000, padding_after INTEGER NOT NULL DEFAULT 300000, max_recordings INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `);
  return db;
}

describe('additive recording schema migration', () => {
  it('upgrades an existing database transactionally without rebuilding tables', () => {
    const db = oldDatabase();
    db.prepare(`INSERT INTO programs (channel_id,title,start_time,stop_time) VALUES ('live_1','SportsCenter',1,2)`).run();
    ensureRecordingSchema(db);
    ensureRecordingSchema(db);

    const programColumns = new Set((db.pragma('table_info(programs)') as Array<{ name: string }>).map(row => row.name));
    expect(programColumns).toEqual(expect.objectContaining(new Set([
      'provider_event_id', 'provider_epg_id', 'subtitle', 'episode_numbers_json', 'is_repeat',
      'is_new', 'is_live', 'original_air_date', 'raw_metadata', 'source', 'airing_key', 'content_key',
    ])));
    const recordingColumns = new Set((db.pragma('table_info(recordings)') as Array<{ name: string }>).map(row => row.name));
    expect(recordingColumns.has('master_file_path')).toBe(true);
    expect(recordingColumns.has('analysis_state')).toBe(true);
    expect(recordingColumns.has('commercial_skip_override')).toBe(true);
    const ruleColumns = new Set((db.pragma('table_info(recording_rules)') as Array<{ name: string }>).map(row => row.name));
    expect(ruleColumns.has('retention_count')).toBe(true);
    expect(db.prepare('SELECT title FROM programs').get()).toEqual({ title: 'SportsCenter' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commercial_segments'").get()).toEqual({ name: 'commercial_segments' });
    db.close();
  });

  it('rolls back the whole migration if an additive step fails', () => {
    const db = oldDatabase();
    db.exec('CREATE VIEW commercial_segments AS SELECT 1 AS bad');
    expect(() => ensureRecordingSchema(db)).toThrow();
    const columns = (db.pragma('table_info(programs)') as Array<{ name: string }>).map(row => row.name);
    expect(columns).not.toContain('airing_key');
    db.close();
  });

  it('rebuilds a pre-release commercial segment variant while preserving rows', () => {
    const db = oldDatabase();
    db.exec(`
      INSERT INTO recordings (id,channel_id,channel_name,title,status,start_time,end_time,created_at)
      VALUES ('r1','c','C','T','completed',1,2,1);
      CREATE TABLE commercial_segments (
        id INTEGER PRIMARY KEY, recording_id TEXT NOT NULL, start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL, source TEXT, state TEXT
      );
      INSERT INTO commercial_segments VALUES (7,'r1',10,20,'manual','accepted');
    `);

    ensureRecordingSchema(db);

    const columns = new Set((db.pragma('table_info(commercial_segments)') as Array<{ name: string }>).map(row => row.name));
    expect(columns).toEqual(expect.objectContaining(new Set(['detector', 'confidence', 'detector_version', 'review_state', 'created_at', 'updated_at'])));
    expect(db.prepare('SELECT recording_id,start_seconds,end_seconds,detector,review_state FROM commercial_segments').get())
      .toEqual({ recording_id: 'r1', start_seconds: 10, end_seconds: 20, detector: 'manual', review_state: 'accepted' });
    db.close();
  });

  it('resolves legacy non-cancelled airing duplicates before enforcing database dedupe', () => {
    const db = oldDatabase();
    db.exec(`
      ALTER TABLE recordings ADD COLUMN airing_key TEXT;
      INSERT INTO recordings (id,channel_id,channel_name,title,status,start_time,end_time,created_at,airing_key)
      VALUES ('first','c','C','T','scheduled',1,2,1,'same'),
             ('second','c','C','T','completed',1,2,2,'same');
    `);

    ensureRecordingSchema(db);

    expect(db.prepare("SELECT id,airing_key FROM recordings ORDER BY created_at").all()).toEqual([
      { id: 'first', airing_key: 'same' }, { id: 'second', airing_key: null },
    ]);
    expect(() => db.prepare(`
      INSERT INTO recordings (id,channel_id,channel_name,title,status,start_time,end_time,created_at,airing_key)
      VALUES ('third','c','C','T','scheduled',1,2,3,'same')
    `).run()).toThrow(/unique/i);
    db.close();
  });
});

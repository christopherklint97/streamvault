// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRecordingSchema } from './db-migrations.js';
import { createEpgWriteWorker } from './epg-write-worker.js';

describe('EPG write worker', () => {
  it('persists an on-demand snapshot on a separate thread without erasing other channels', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-epg-write-'));
    const dbPath = path.join(dir, 'guide.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', start_time INTEGER NOT NULL, stop_time INTEGER NOT NULL, category TEXT DEFAULT '');
      CREATE TABLE recordings (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, file_path TEXT, file_size INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, error TEXT, rule_id TEXT, program_title TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE recording_rules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, match_title TEXT NOT NULL, match_type TEXT NOT NULL, enabled INTEGER NOT NULL, padding_before INTEGER NOT NULL, padding_after INTEGER NOT NULL, max_recordings INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
    ensureRecordingSchema(db);
    const writer = createEpgWriteWorker(dbPath);
    try {
      const program = (channel_id: string) => ({ channel_id, title: 'News', description: '', start_time: 100, stop_time: 200, category: '', airing_key: channel_id });
      await writer.save([program('live_1'), program('live_2')]);
      const pending = writer.save([program('live_1')]);
      let timerFired = false;
      await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
      expect(timerFired).toBe(true);
      await pending;
      expect(db.prepare('SELECT channel_id FROM programs ORDER BY channel_id').all()).toEqual([{ channel_id: 'live_1' }, { channel_id: 'live_2' }]);
    } finally {
      await writer.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

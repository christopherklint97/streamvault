// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCategoryWriteWorker } from './category-write-worker.js';

describe('category write worker', () => {
  it('publishes a complete category snapshot and fetched timestamp away from the HTTP thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-category-write-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, url TEXT, logo TEXT, grp TEXT, region TEXT, content_type TEXT, category_id TEXT, sort_order INTEGER, added INTEGER, epg_channel_id TEXT);
      CREATE TABLE categories (id TEXT PRIMARY KEY, fetched_at INTEGER, stream_count INTEGER);
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO config (key, value) VALUES ('input_mode', 'xtream');
      INSERT INTO config (key, value) VALUES ('catalog_generation', 'first');
      INSERT INTO categories (id, fetched_at, stream_count) VALUES ('uk', 0, 0)`);
    db.close();
    const writer = createCategoryWriteWorker(dbPath);
    const channel = { id: 'one', name: 'One', url: 'https://example.test/live', logo: '', grp: 'UK', region: 'UK', content_type: 'livetv' };
    try {
      await writer.save('uk', [channel], 'first');
      const check = new Database(dbPath);
      expect(check.prepare('SELECT id FROM channels').all()).toEqual([{ id: 'one' }]);
      expect(check.prepare('SELECT stream_count FROM categories WHERE id = ?').get('uk')).toEqual({ stream_count: 1 });
      check.close();
      await writer.save('uk', [], 'first');
      const emptied = new Database(dbPath);
      expect(emptied.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 0 });
      emptied.close();
      const nextGeneration = new Database(dbPath);
      nextGeneration.prepare("UPDATE config SET value = 'second' WHERE key = 'catalog_generation'").run();
      nextGeneration.close();
      await expect(writer.save('uk', [channel], 'first')).rejects.toThrow(/generation|source/i);
      const afterStaleResult = new Database(dbPath);
      expect(afterStaleResult.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 0 });
      afterStaleResult.close();
      const mode = new Database(dbPath);
      mode.prepare("UPDATE config SET value = 'manual' WHERE key = 'input_mode'").run();
      mode.close();
      await expect(writer.save('uk', [channel], 'second')).rejects.toThrow(/source|mode|manual/i);
      const afterModeChange = new Database(dbPath);
      expect(afterModeChange.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 0 });
      afterModeChange.close();
    } finally {
      await writer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpgReadWorker } from './epg-read-worker.js';

describe('EPG read worker', () => {
  it('reads only the requested channels and overlapping airings without blocking HTTP dispatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-epg-read-'));
    const dbPath = path.join(dir, 'guide.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE programs (channel_id TEXT, title TEXT, description TEXT, start_time INTEGER, stop_time INTEGER, last_seen INTEGER, raw_metadata TEXT)');
    db.prepare('INSERT INTO programs VALUES (?, ?, ?, ?, ?, ?, ?)').run('live_1', 'Current', '', 100, 200, 150, '{}');
    db.prepare('INSERT INTO programs VALUES (?, ?, ?, ?, ?, ?, ?)').run('live_2', 'Other', '', 100, 200, 150, '{}');
    db.close();
    const reader = createEpgReadWorker(dbPath);
    try {
      const pending = reader.read(['live_1'], 110, 180);
      let timerFired = false;
      await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
      expect(timerFired).toBe(true);
      expect((await pending).map(row => row.title)).toEqual(['Current']);
      expect(await reader.read(['live_1'], 210, 250)).toEqual([]);
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

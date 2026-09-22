// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getProgramWindow, PROGRAM_WINDOW_SQL } from './program-window.js';

describe('program window query', () => {
  it('filters with the time index before ordering the matching window', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE programs (
        id INTEGER PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        stop_time INTEGER NOT NULL,
        category TEXT NOT NULL
      );
      CREATE INDEX idx_programs_channel ON programs(channel_id);
      CREATE INDEX idx_programs_time ON programs(start_time, stop_time);
      INSERT INTO programs VALUES
        (1, 'c2', 'Old', '', 0, 10, ''),
        (2, 'c2', 'Second', '', 120, 180, ''),
        (3, 'c1', 'First', '', 100, 200, '');
    `);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${PROGRAM_WINDOW_SQL}`).all(190, 90) as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes('idx_programs_time'))).toBe(true);
    expect(plan.some(row => row.detail.includes('idx_programs_channel'))).toBe(false);
    expect(getProgramWindow(db, 90, 190).map(row => row.title)).toEqual(['First', 'Second']);
    db.close();
  });
});

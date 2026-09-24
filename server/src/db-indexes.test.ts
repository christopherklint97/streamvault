// @vitest-environment node
import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureBrowseIndexes, ensureChannelSearchIndex } from './db-indexes.js';

test('browse pages use indexes instead of temporary full-catalogue sorts', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE channels(id TEXT PRIMARY KEY, content_type TEXT, grp TEXT, added INTEGER, sort_order INTEGER, name TEXT)');
  ensureBrowseIndexes(db);
  ensureBrowseIndexes(db);
  for (const filter of ["content_type = 'movies'", "grp = 'Movies'"]) {
    for (const ordering of ['added DESC, name', 'sort_order, name']) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM channels WHERE ${filter} ORDER BY ${ordering} LIMIT 20`).all() as { detail: string }[];
      expect(plan.some(row => row.detail.includes('USING INDEX'))).toBe(true);
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
    }
  }
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM channels ORDER BY sort_order, name LIMIT 20').all() as { detail: string }[];
  expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
  db.close();
});

test('trigram search index includes existing channels and follows changes', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE channels(id TEXT PRIMARY KEY, name TEXT); INSERT INTO channels VALUES ('1', 'The Matrix')");
  ensureChannelSearchIndex(db);
  ensureChannelSearchIndex(db);
  const search = db.prepare('SELECT channels.id FROM channels JOIN channels_fts ON channels_fts.rowid = channels.rowid WHERE channels_fts.name LIKE ?');

  expect(search.all('%matrix%')).toEqual([{ id: '1' }]);
  db.exec("INSERT INTO channels VALUES ('2', 'Matrix Reloaded'); UPDATE channels SET name = 'Inception' WHERE id = '1'");
  expect(search.all('%matrix%')).toEqual([{ id: '2' }]);
  db.exec("DELETE FROM channels WHERE id = '2'");
  expect(search.all('%matrix%')).toEqual([]);
  db.close();
});

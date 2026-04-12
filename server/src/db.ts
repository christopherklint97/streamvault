import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'streamvault.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

logger.info(`Opening database at ${DB_PATH}`);
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    logo TEXT DEFAULT '',
    grp TEXT DEFAULT '',
    region TEXT DEFAULT '',
    content_type TEXT DEFAULT 'livetv'
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content_type TEXT DEFAULT 'livetv',
    stream_count INTEGER DEFAULT 0,
    fetched_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    start_time INTEGER NOT NULL,
    stop_time INTEGER NOT NULL,
    category TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_programs_channel ON programs(channel_id);
  CREATE INDEX IF NOT EXISTS idx_programs_time ON programs(start_time, stop_time);
  CREATE INDEX IF NOT EXISTS idx_channels_grp ON channels(grp);
  CREATE INDEX IF NOT EXISTS idx_channels_content_type ON channels(content_type);
`);

// Migration: add category_id column to existing channels table
try {
  db.prepare('SELECT category_id FROM channels LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE channels ADD COLUMN category_id TEXT DEFAULT \'\'');
  logger.info('Migrated channels table: added category_id column');
}

// Migration: add fetched_at column to existing categories table
try {
  db.prepare('SELECT fetched_at FROM categories LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE categories ADD COLUMN fetched_at INTEGER DEFAULT 0');
  logger.info('Migrated categories table: added fetched_at column');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_channels_category_id ON channels(category_id)');

// Migration: add sort_order column to existing channels table
try {
  db.prepare('SELECT sort_order FROM channels LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE channels ADD COLUMN sort_order INTEGER DEFAULT 0');
  logger.info('Migrated channels table: added sort_order column');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name COLLATE NOCASE)');

// Migration: add 'added' column (unix timestamp for when stream was added upstream)
try {
  db.prepare('SELECT added FROM channels LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE channels ADD COLUMN added INTEGER DEFAULT 0');
  logger.info('Migrated channels table: added "added" column');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_channels_added ON channels(added)');

// ---------- Recording tables ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    actual_start INTEGER,
    actual_end INTEGER,
    file_path TEXT,
    file_size INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    error TEXT,
    rule_id TEXT,
    program_title TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recording_rules (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    match_title TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains',
    enabled INTEGER NOT NULL DEFAULT 1,
    padding_before INTEGER NOT NULL DEFAULT 120000,
    padding_after INTEGER NOT NULL DEFAULT 300000,
    max_recordings INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
  CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time);
  CREATE INDEX IF NOT EXISTS idx_recordings_channel_id ON recordings(channel_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_rule_id ON recordings(rule_id);
  CREATE INDEX IF NOT EXISTS idx_recording_rules_channel_id ON recording_rules(channel_id);
`);

// ---------- Config helpers ----------

export function getConfig(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setConfig(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

// ---------- Category helpers ----------

export interface DBCategory {
  id: string;
  name: string;
  content_type: string;
  stream_count: number;
  fetched_at: number;
}

// Upsert category: preserve fetched_at if the category already exists
const upsertCategory = db.prepare(`
  INSERT INTO categories (id, name, content_type, stream_count, fetched_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    content_type = excluded.content_type,
    stream_count = CASE WHEN excluded.stream_count > 0 THEN excluded.stream_count ELSE categories.stream_count END,
    fetched_at = CASE WHEN categories.fetched_at > 0 THEN categories.fetched_at ELSE excluded.fetched_at END
`);

const deleteStaleCategories = db.prepare(
  'DELETE FROM categories WHERE id NOT IN (SELECT value FROM json_each(?))'
);

const saveCategoriesBatch = db.transaction((categories: DBCategory[]) => {
  for (const c of categories) {
    upsertCategory.run(c.id, c.name, c.content_type, c.stream_count, c.fetched_at);
  }
  // Remove categories that no longer exist upstream
  const ids = JSON.stringify(categories.map(c => c.id));
  deleteStaleCategories.run(ids);
});

export function saveCategories(categories: DBCategory[]): void {
  saveCategoriesBatch(categories);
}

const updateCategoryFetchedAt = db.prepare(
  'UPDATE categories SET fetched_at = ?, stream_count = ? WHERE id = ?'
);

export function markCategoryFetched(categoryId: string, streamCount: number): void {
  updateCategoryFetchedAt.run(Date.now(), streamCount, categoryId);
}

export function getCategories(contentType?: string): DBCategory[] {
  if (contentType) {
    return db.prepare('SELECT * FROM categories WHERE content_type = ? ORDER BY name').all(contentType) as DBCategory[];
  }
  return db.prepare('SELECT * FROM categories ORDER BY name').all() as DBCategory[];
}

export function getCategoryByName(name: string): DBCategory | undefined {
  return db.prepare('SELECT * FROM categories WHERE name = ?').get(name) as DBCategory | undefined;
}

export function getCategoryCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM categories').get() as { count: number };
  return row.count;
}

// ---------- Channel helpers ----------

export interface DBChannel {
  id: string;
  name: string;
  url: string;
  logo: string;
  grp: string;
  region: string;
  content_type: string;
  category_id?: string;
  sort_order?: number;
  added?: number;
}

const insertChannel = db.prepare(
  'INSERT OR REPLACE INTO channels (id, name, url, logo, grp, region, content_type, category_id, sort_order, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const clearChannels = db.prepare('DELETE FROM channels');

const insertChannelsBatch = db.transaction((channels: DBChannel[]) => {
  clearChannels.run();
  for (const ch of channels) {
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type, ch.category_id || '', ch.sort_order ?? 0, ch.added ?? 0);
  }
});

export function saveChannels(channels: DBChannel[]): void {
  insertChannelsBatch(channels);
}

export function clearCachedStreams(): void {
  clearChannels.run();
  logger.info('Cleared all cached streams');
}

const clearChannelsByCategory = db.prepare('DELETE FROM channels WHERE category_id = ?');

const insertChannelsForCategory = db.transaction((categoryId: string, channels: DBChannel[]) => {
  clearChannelsByCategory.run(categoryId);
  for (const ch of channels) {
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type, ch.category_id || '', ch.sort_order ?? 0, ch.added ?? 0);
  }
});

export function saveChannelsForCategory(categoryId: string, channels: DBChannel[]): void {
  insertChannelsForCategory(categoryId, channels);
}

export function getChannelById(id: string): DBChannel | undefined {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as DBChannel | undefined;
}

export function getChannelsByIds(ids: string[]): DBChannel[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM channels WHERE id IN (${placeholders})`).all(...ids) as DBChannel[];
}

export function getChannels(): DBChannel[] {
  return db.prepare('SELECT * FROM channels ORDER BY sort_order, name').all() as DBChannel[];
}

export function getChannelsByGroup(group: string, limit?: number, cursorSort?: number, cursorName?: string): DBChannel[] {
  if (limit !== undefined && cursorSort !== undefined && cursorName !== undefined) {
    // Cursor pagination: fetch rows after the cursor (sort_order, name)
    return db.prepare(
      `SELECT * FROM channels WHERE grp = ? AND (sort_order > ? OR (sort_order = ? AND name > ?)) ORDER BY sort_order, name LIMIT ?`
    ).all(group, cursorSort, cursorSort, cursorName, limit) as DBChannel[];
  }
  if (limit !== undefined) {
    // First page: no cursor
    return db.prepare('SELECT * FROM channels WHERE grp = ? ORDER BY sort_order, name LIMIT ?').all(group, limit) as DBChannel[];
  }
  return db.prepare('SELECT * FROM channels WHERE grp = ? ORDER BY sort_order, name').all(group) as DBChannel[];
}

export function getChannelsByGroupCursor(group: string, limit: number, afterCursor?: string, contentType?: string): DBChannel[] {
  const isNewestFirst = contentType === 'movies' || contentType === 'series';

  if (isNewestFirst) {
    // Movies/series: newest first (added DESC, name ASC)
    if (afterCursor) {
      const cursor = JSON.parse(afterCursor) as { a: number; n: string };
      return db.prepare(
        'SELECT * FROM channels WHERE grp = ? AND (added < ? OR (added = ? AND name > ?)) ORDER BY added DESC, name LIMIT ?'
      ).all(group, cursor.a, cursor.a, cursor.n, limit) as DBChannel[];
    }
    return db.prepare('SELECT * FROM channels WHERE grp = ? ORDER BY added DESC, name LIMIT ?').all(group, limit) as DBChannel[];
  }

  // Live TV: original order (sort_order ASC, name ASC)
  if (afterCursor) {
    const cursor = JSON.parse(afterCursor) as { s: number; n: string };
    return db.prepare(
      'SELECT * FROM channels WHERE grp = ? AND (sort_order > ? OR (sort_order = ? AND name > ?)) ORDER BY sort_order, name LIMIT ?'
    ).all(group, cursor.s, cursor.s, cursor.n, limit) as DBChannel[];
  }
  return db.prepare('SELECT * FROM channels WHERE grp = ? ORDER BY sort_order, name LIMIT ?').all(group, limit) as DBChannel[];
}

export function getChannelCountByGroup(group: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM channels WHERE grp = ?').get(group) as { count: number };
  return row.count;
}

export function getChannelsByContentTypeCursor(contentType: string, limit: number, afterCursor?: string): DBChannel[] {
  const isNewestFirst = contentType === 'movies' || contentType === 'series';

  if (isNewestFirst) {
    if (afterCursor) {
      const cursor = JSON.parse(afterCursor) as { a: number; n: string };
      return db.prepare(
        'SELECT * FROM channels WHERE content_type = ? AND (added < ? OR (added = ? AND name > ?)) ORDER BY added DESC, name LIMIT ?'
      ).all(contentType, cursor.a, cursor.a, cursor.n, limit) as DBChannel[];
    }
    return db.prepare('SELECT * FROM channels WHERE content_type = ? ORDER BY added DESC, name LIMIT ?').all(contentType, limit) as DBChannel[];
  }

  // Live TV: original order
  if (afterCursor) {
    const cursor = JSON.parse(afterCursor) as { s: number; n: string };
    return db.prepare(
      'SELECT * FROM channels WHERE content_type = ? AND (sort_order > ? OR (sort_order = ? AND name > ?)) ORDER BY sort_order, name LIMIT ?'
    ).all(contentType, cursor.s, cursor.s, cursor.n, limit) as DBChannel[];
  }
  return db.prepare('SELECT * FROM channels WHERE content_type = ? ORDER BY sort_order, name LIMIT ?').all(contentType, limit) as DBChannel[];
}

// --- Direct substring search ---

export function searchChannelsByName(query: string, contentType?: string, group?: string): DBChannel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  // All words must appear in the name (AND logic)
  let sql = 'SELECT * FROM channels WHERE ';
  const params: (string | number)[] = [];
  const likeClauses: string[] = [];
  for (const word of words) {
    likeClauses.push('name LIKE ? COLLATE NOCASE');
    params.push(`%${word}%`);
  }
  sql += likeClauses.join(' AND ');
  if (contentType) { sql += ' AND content_type = ?'; params.push(contentType); }
  if (group) { sql += ' AND grp = ?'; params.push(group); }
  sql += ' LIMIT 200';

  const results = db.prepare(sql).all(...params) as DBChannel[];

  // Sort: exact full-query match first, then starts-with, then alphabetical
  const queryLower = query.trim().toLowerCase();
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aExact = aName === queryLower ? 2 : aName.includes(queryLower) ? 1 : 0;
    const bExact = bName === queryLower ? 2 : bName.includes(queryLower) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aStarts = aName.startsWith(queryLower) ? 1 : 0;
    const bStarts = bName.startsWith(queryLower) ? 1 : 0;
    if (aStarts !== bStarts) return bStarts - aStarts;
    return aName.localeCompare(bName);
  });

  return results.slice(0, 50);
}

export function getChannelCountByContentType(contentType: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM channels WHERE content_type = ?').get(contentType) as { count: number };
  return row.count;
}

export function getChannelCountByCategory(categoryId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM channels WHERE category_id = ?').get(categoryId) as { count: number };
  return row.count;
}

export function getGroups(): string[] {
  const rows = db.prepare('SELECT DISTINCT grp FROM channels WHERE grp != \'\' ORDER BY grp').all() as { grp: string }[];
  return rows.map(r => r.grp);
}

export function getRegions(): string[] {
  const rows = db.prepare('SELECT DISTINCT region FROM channels WHERE region != \'\' ORDER BY region').all() as { region: string }[];
  return rows.map(r => r.region);
}

export function getChannelCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
  return row.count;
}

export function getContentTypeCounts(): Record<string, number> {
  const rows = db.prepare('SELECT content_type, COUNT(*) as count FROM channels GROUP BY content_type').all() as { content_type: string; count: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.content_type] = r.count;
  return counts;
}

// ---------- Program helpers ----------

export interface DBProgram {
  channel_id: string;
  title: string;
  description: string;
  start_time: number;
  stop_time: number;
  category: string;
}

const insertProgram = db.prepare(
  'INSERT INTO programs (channel_id, title, description, start_time, stop_time, category) VALUES (?, ?, ?, ?, ?, ?)'
);

const clearPrograms = db.prepare('DELETE FROM programs');

const insertProgramsBatch = db.transaction((programs: DBProgram[]) => {
  clearPrograms.run();
  for (const p of programs) {
    insertProgram.run(p.channel_id, p.title, p.description, p.start_time, p.stop_time, p.category);
  }
});

export function savePrograms(programs: DBProgram[]): void {
  insertProgramsBatch(programs);
}

/** Save programs for specific channels without clearing the entire table */
const clearProgramsByChannel = db.prepare('DELETE FROM programs WHERE channel_id = ?');

const saveProgramsForChannelsBatch = db.transaction((programs: DBProgram[]) => {
  // Collect unique channel IDs and clear their existing programs
  const channelIds = new Set(programs.map(p => p.channel_id));
  for (const cid of channelIds) {
    clearProgramsByChannel.run(cid);
  }
  for (const p of programs) {
    insertProgram.run(p.channel_id, p.title, p.description, p.start_time, p.stop_time, p.category);
  }
});

export function saveProgramsForChannels(programs: DBProgram[]): void {
  if (programs.length === 0) return;
  saveProgramsForChannelsBatch(programs);
}

export function getPrograms(from?: number, to?: number): DBProgram[] {
  if (from !== undefined && to !== undefined) {
    return db.prepare(
      'SELECT * FROM programs WHERE start_time < ? AND stop_time > ? ORDER BY channel_id, start_time'
    ).all(to, from) as DBProgram[];
  }
  return db.prepare('SELECT * FROM programs ORDER BY channel_id, start_time').all() as DBProgram[];
}

/** Get programs for specific channel IDs within a time range */
export function getProgramsByChannelIds(channelIds: string[], from?: number, to?: number): DBProgram[] {
  if (channelIds.length === 0) return [];
  const placeholders = channelIds.map(() => '?').join(',');
  if (from !== undefined && to !== undefined) {
    return db.prepare(
      `SELECT * FROM programs WHERE channel_id IN (${placeholders}) AND start_time < ? AND stop_time > ? ORDER BY channel_id, start_time`
    ).all(...channelIds, to, from) as DBProgram[];
  }
  return db.prepare(
    `SELECT * FROM programs WHERE channel_id IN (${placeholders}) ORDER BY channel_id, start_time`
  ).all(...channelIds) as DBProgram[];
}

/** Get all programs for a single channel, ordered by start time */
export function getProgramsByChannel(channelId: string, from?: number, to?: number): DBProgram[] {
  if (from !== undefined && to !== undefined) {
    return db.prepare(
      'SELECT * FROM programs WHERE channel_id = ? AND start_time < ? AND stop_time > ? ORDER BY start_time'
    ).all(channelId, to, from) as DBProgram[];
  }
  return db.prepare(
    'SELECT * FROM programs WHERE channel_id = ? ORDER BY start_time'
  ).all(channelId) as DBProgram[];
}

export function getProgramCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM programs').get() as { count: number };
  return row.count;
}

// ---------- Recording helpers ----------

export interface DBRecording {
  id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  status: string;
  start_time: number;
  end_time: number;
  actual_start: number | null;
  actual_end: number | null;
  file_path: string | null;
  file_size: number;
  duration: number;
  error: string | null;
  rule_id: string | null;
  program_title: string | null;
  created_at: number;
}

export function insertRecording(rec: DBRecording): void {
  db.prepare(`
    INSERT INTO recordings (id, channel_id, channel_name, title, status, start_time, end_time, actual_start, actual_end, file_path, file_size, duration, error, rule_id, program_title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rec.id, rec.channel_id, rec.channel_name, rec.title, rec.status, rec.start_time, rec.end_time, rec.actual_start, rec.actual_end, rec.file_path, rec.file_size, rec.duration, rec.error, rec.rule_id, rec.program_title, rec.created_at);
}

export function updateRecording(id: string, updates: Partial<Omit<DBRecording, 'id'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val ?? null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE recordings SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRecording(id: string): void {
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
}

export function getRecording(id: string): DBRecording | undefined {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as DBRecording | undefined;
}

export function getRecordings(filter?: { status?: string; limit?: number; offset?: number }): DBRecording[] {
  let sql = 'SELECT * FROM recordings';
  const params: unknown[] = [];
  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY start_time DESC';
  if (filter?.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }
  if (filter?.offset) {
    sql += ' OFFSET ?';
    params.push(filter.offset);
  }
  return db.prepare(sql).all(...params) as DBRecording[];
}

export function getRecordingsByStatus(status: string): DBRecording[] {
  return db.prepare('SELECT * FROM recordings WHERE status = ? ORDER BY start_time').all(status) as DBRecording[];
}

export function getUpcomingRecordings(from: number, to: number): DBRecording[] {
  return db.prepare(
    'SELECT * FROM recordings WHERE status = \'scheduled\' AND start_time >= ? AND start_time <= ? ORDER BY start_time'
  ).all(from, to) as DBRecording[];
}

export function getRecordingsByRuleId(ruleId: string): DBRecording[] {
  return db.prepare('SELECT * FROM recordings WHERE rule_id = ? ORDER BY start_time DESC').all(ruleId) as DBRecording[];
}

// ---------- Recording Rule helpers ----------

export interface DBRecordingRule {
  id: string;
  channel_id: string;
  channel_name: string;
  match_title: string;
  match_type: string;
  enabled: number;
  padding_before: number;
  padding_after: number;
  max_recordings: number;
  created_at: number;
}

export function insertRecordingRule(rule: DBRecordingRule): void {
  db.prepare(`
    INSERT INTO recording_rules (id, channel_id, channel_name, match_title, match_type, enabled, padding_before, padding_after, max_recordings, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rule.id, rule.channel_id, rule.channel_name, rule.match_title, rule.match_type, rule.enabled, rule.padding_before, rule.padding_after, rule.max_recordings, rule.created_at);
}

export function updateRecordingRule(id: string, updates: Partial<Omit<DBRecordingRule, 'id'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val ?? null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE recording_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRecordingRule(id: string): void {
  db.prepare('DELETE FROM recording_rules WHERE id = ?').run(id);
}

export function getRecordingRule(id: string): DBRecordingRule | undefined {
  return db.prepare('SELECT * FROM recording_rules WHERE id = ?').get(id) as DBRecordingRule | undefined;
}

export function getRecordingRules(): DBRecordingRule[] {
  return db.prepare('SELECT * FROM recording_rules ORDER BY created_at DESC').all() as DBRecordingRule[];
}

export function getEnabledRecordingRules(): DBRecordingRule[] {
  return db.prepare('SELECT * FROM recording_rules WHERE enabled = 1 ORDER BY created_at').all() as DBRecordingRule[];
}

export default db;

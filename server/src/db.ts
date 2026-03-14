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
}

const insertChannel = db.prepare(
  'INSERT OR REPLACE INTO channels (id, name, url, logo, grp, region, content_type, category_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const clearChannels = db.prepare('DELETE FROM channels');

const insertChannelsBatch = db.transaction((channels: DBChannel[]) => {
  clearChannels.run();
  for (const ch of channels) {
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type, ch.category_id || '', ch.sort_order ?? 0);
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
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type, ch.category_id || '', ch.sort_order ?? 0);
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

export function getChannelsByGroupCursor(group: string, limit: number, afterName?: string): DBChannel[] {
  if (afterName) {
    return db.prepare('SELECT * FROM channels WHERE grp = ? AND name > ? ORDER BY name LIMIT ?').all(group, afterName, limit) as DBChannel[];
  }
  return db.prepare('SELECT * FROM channels WHERE grp = ? ORDER BY name LIMIT ?').all(group, limit) as DBChannel[];
}

export function getChannelCountByGroup(group: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM channels WHERE grp = ?').get(group) as { count: number };
  return row.count;
}

export function getChannelsByContentTypeCursor(contentType: string, limit: number, afterName?: string): DBChannel[] {
  if (afterName) {
    return db.prepare('SELECT * FROM channels WHERE content_type = ? AND name > ? ORDER BY name LIMIT ?').all(contentType, afterName, limit) as DBChannel[];
  }
  return db.prepare('SELECT * FROM channels WHERE content_type = ? ORDER BY name LIMIT ?').all(contentType, limit) as DBChannel[];
}

// --- Trigram fuzzy search ---

function trigrams(s: string): Set<string> {
  const t = new Set<string>();
  const low = s.toLowerCase();
  for (let i = 0; i <= low.length - 3; i++) {
    t.add(low.slice(i, i + 3));
  }
  return t;
}

function trigramScore(query: string, target: string): number {
  const qt = trigrams(query);
  const tt = trigrams(target);
  if (qt.size === 0) return 0;
  let overlap = 0;
  for (const t of qt) {
    if (tt.has(t)) overlap++;
  }
  return overlap / qt.size;
}

export function searchChannelsByName(query: string, contentType?: string, group?: string): DBChannel[] {
  // Phase 1: broad SQL candidate fetch using LIKE for each word
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  // Build SQL: match using short prefixes (3+ chars) for broad candidate net
  // This catches typos since we only need partial substring overlap
  let sql = 'SELECT * FROM channels WHERE (';
  const params: (string | number)[] = [];
  const likeClauses: string[] = [];
  for (const word of words) {
    if (word.length >= 4) {
      // Use 4-char prefix for broad match — catches typos later in the word
      likeClauses.push('name LIKE ?');
      params.push(`%${word.slice(0, 4)}%`);
    } else {
      likeClauses.push('name LIKE ?');
      params.push(`%${word}%`);
    }
  }
  sql += likeClauses.join(' OR ') + ')';
  if (contentType) { sql += ' AND content_type = ?'; params.push(contentType); }
  if (group) { sql += ' AND grp = ?'; params.push(group); }
  sql += ' LIMIT 1000'; // broad candidate pool for fuzzy scoring

  const candidates = db.prepare(sql).all(...params) as DBChannel[];

  // Phase 2: score candidates with trigram similarity
  const queryLower = query.toLowerCase();
  const scored = candidates.map(ch => ({
    channel: ch,
    score: trigramScore(queryLower, ch.name.toLowerCase()),
    exact: ch.name.toLowerCase().includes(queryLower) ? 1 : 0,
  }));

  // Filter: require at least some trigram overlap (0.15 threshold allows typos)
  const MIN_SCORE = 0.15;
  const filtered = scored.filter(s => s.score >= MIN_SCORE || s.exact);

  // Sort: exact matches first, then by trigram score desc, then alphabetical
  filtered.sort((a, b) => {
    if (a.exact !== b.exact) return b.exact - a.exact;
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    return a.channel.name.localeCompare(b.channel.name);
  });

  return filtered.slice(0, 50).map(s => s.channel);
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

export function getPrograms(from?: number, to?: number): DBProgram[] {
  if (from !== undefined && to !== undefined) {
    return db.prepare(
      'SELECT * FROM programs WHERE start_time < ? AND stop_time > ? ORDER BY channel_id, start_time'
    ).all(to, from) as DBProgram[];
  }
  return db.prepare('SELECT * FROM programs ORDER BY channel_id, start_time').all() as DBProgram[];
}

export function getProgramCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM programs').get() as { count: number };
  return row.count;
}

export default db;

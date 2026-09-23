import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { ensureBrowseIndexes } from './db-indexes.js';
import { createCategorySnapshotWriter } from './channel-snapshot.js';
import { ensureRecordingSchema } from './db-migrations.js';
import { createCommercialStore, type CommercialSegmentWrite, type DBCommercialSegment } from './commercial-store.js';
import { createProgramStore } from './program-store.js';
import { getProgramWindow } from './program-window.js';
import {
  backupDatabaseInWorker,
  checkDatabaseReadable,
  isDatabaseBackupDue,
  restoreLatestValidBackup,
  validateOpenDatabase,
} from './db-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'streamvault.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

fs.mkdirSync(DATA_DIR, { recursive: true });

function openDatabase(): InstanceType<typeof Database> {
  const instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  return instance;
}

function quarantineDatabaseFiles(reason: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-shm', '-wal']) {
    const file = DB_PATH + suffix;
    if (!fs.existsSync(file)) continue;
    const quarantined = `${file}.corrupt-${ts}`;
    fs.renameSync(file, quarantined);
    logger.error(`Quarantined corrupt DB file: ${file} -> ${quarantined}`);
  }
  logger.error(`Database quarantined. Reason: ${reason}`);
}

logger.info(`Opening database at ${DB_PATH}`);
const existingDatabase = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
let db = openDatabase();

if (existingDatabase) {
  const validation = validateOpenDatabase(db);
  if (!validation.ok) {
    try { db.close(); } catch { /* ignore close errors while recovering */ }
    quarantineDatabaseFiles(validation.error || 'Database validation failed');
    const restored = restoreLatestValidBackup(DB_PATH, BACKUP_DIR);
    if (restored) logger.warn(`Restored database from latest valid backup: ${restored}`);
    else logger.error('No valid backup found; creating a fresh database');
    db = openDatabase();
  } else {
    logger.info('Database integrity check passed');
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    logo TEXT DEFAULT '',
    grp TEXT DEFAULT '',
    region TEXT DEFAULT '',
    content_type TEXT DEFAULT 'livetv',
    epg_channel_id TEXT DEFAULT ''
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

try {
  db.prepare('SELECT epg_channel_id FROM channels LIMIT 1').get();
} catch {
  db.exec("ALTER TABLE channels ADD COLUMN epg_channel_id TEXT DEFAULT ''");
  logger.info('Migrated channels table: added epg_channel_id column');
}

db.exec("CREATE INDEX IF NOT EXISTS idx_channels_epg_available ON channels(id) WHERE content_type = 'livetv' AND epg_channel_id <> ''");
ensureBrowseIndexes(db);

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
    program_start_time INTEGER,
    program_stop_time INTEGER,
    rule_revision INTEGER,
    cadence_slot INTEGER,
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
    retention_count INTEGER NOT NULL DEFAULT 0,
    airing_policy TEXT NOT NULL DEFAULT 'every',
    repeat_policy TEXT NOT NULL DEFAULT 'include_unknown',
    cadence_mode TEXT NOT NULL DEFAULT 'every',
    cadence_interval INTEGER NOT NULL DEFAULT 1,
    daily_start_minutes INTEGER NOT NULL DEFAULT 0,
    schedule_timezone TEXT NOT NULL DEFAULT 'Europe/Stockholm',
    rule_revision INTEGER NOT NULL DEFAULT 1,
    cadence_last_success_start INTEGER,
    cadence_last_success_key TEXT,
    cadence_occurrence_progress INTEGER NOT NULL DEFAULT 0,
    cadence_cursor_start INTEGER,
    cadence_cursor_key TEXT,
    cadence_retry_start INTEGER,
    cadence_retry_key TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
  CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time);
  CREATE INDEX IF NOT EXISTS idx_recordings_channel_id ON recordings(channel_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_rule_id ON recordings(rule_id);
  CREATE INDEX IF NOT EXISTS idx_recording_rules_channel_id ON recording_rules(channel_id);
`);

// Additive migrations run only after all legacy base tables exist. They are
// transactional and safe to execute on every startup.
ensureRecordingSchema(db);
const commercialStore = createCommercialStore(db);
const programStore = createProgramStore(db);

// ---------- Lifecycle / backup helpers ----------

let backupInFlight: Promise<string | null> | null = null;

export function closeDatabase(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logger.warn(`WAL checkpoint on close failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    db.close();
    logger.info('Database closed cleanly');
  } catch (err) {
    logger.warn(`db.close() failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function getDatabaseHealth(): { ok: boolean; error?: string } {
  return checkDatabaseReadable(db);
}

export function backupDatabase(): Promise<string | null> {
  if (backupInFlight) return backupInFlight;
  backupInFlight = backupDatabaseInWorker(DB_PATH, BACKUP_DIR, warning => logger.warn(warning))
    .then(target => { logger.info(`Database backed up to ${target}`); return target; })
    .catch(error => { logger.error(`Backup failed: ${error.message}`); return null; })
    .finally(() => { backupInFlight = null; });
  return backupInFlight;
}

export function backupDatabaseIfDue(maxAgeMs: number): Promise<string | null> {
  if (!isDatabaseBackupDue(BACKUP_DIR, maxAgeMs)) {
    logger.info('Recent database backup exists; skipping startup backup');
    return Promise.resolve(null);
  }
  return backupDatabase();
}

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
  epg_channel_id?: string;
}

const insertChannel = db.prepare(
  'INSERT OR REPLACE INTO channels (id, name, url, logo, grp, region, content_type, category_id, sort_order, added, epg_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const clearChannels = db.prepare('DELETE FROM channels');

const insertChannelsBatch = db.transaction((channels: DBChannel[]) => {
  clearChannels.run();
  for (const ch of channels) {
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type, ch.category_id || '', ch.sort_order ?? 0, ch.added ?? 0, ch.epg_channel_id ?? '');
  }
});

export function saveChannels(channels: DBChannel[]): void {
  insertChannelsBatch(channels);
}

export function clearCachedStreams(): void {
  clearChannels.run();
  logger.info('Cleared all cached streams');
}

const writeCategorySnapshot = createCategorySnapshotWriter(db);

export function saveChannelsForCategory(categoryId: string, channels: DBChannel[]): void {
  writeCategorySnapshot(categoryId, channels);
}

export function getChannelById(id: string): DBChannel | undefined {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as DBChannel | undefined;
}

export function getChannelsByIds(ids: string[]): DBChannel[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM channels WHERE id IN (${placeholders})`).all(...ids) as DBChannel[];
}

export function getChannels(limit?: number, cursorSort?: number, cursorName?: string): DBChannel[] {
  if (limit !== undefined && cursorSort !== undefined && cursorName !== undefined) {
    return db.prepare(
      'SELECT * FROM channels WHERE sort_order > ? OR (sort_order = ? AND name > ?) ORDER BY sort_order, name LIMIT ?'
    ).all(cursorSort, cursorSort, cursorName, limit) as DBChannel[];
  }
  if (limit !== undefined) {
    return db.prepare('SELECT * FROM channels ORDER BY sort_order, name LIMIT ?').all(limit) as DBChannel[];
  }
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
  id?: number;
  channel_id: string;
  title: string;
  description: string;
  start_time: number;
  stop_time: number;
  category: string;
  source?: string;
  source_channel_id?: string;
  provider_event_id?: string | null;
  provider_epg_id?: string | null;
  subtitle?: string;
  episode_numbers_json?: string;
  is_repeat?: number | null;
  is_new?: number | null;
  is_live?: number | null;
  original_air_date?: string | null;
  raw_metadata?: string;
  airing_key?: string;
  content_key?: string | null;
  categories_json?: string;
  timezone?: string;
  first_seen?: number;
  last_seen?: number;
  schedule_revision?: number;
}

export function savePrograms(programs: DBProgram[]): void {
  programStore.saveSnapshot(programs);
}

/** Save a completed program snapshot for specific channels without touching other channels. */
export function saveProgramsForChannels(programs: DBProgram[], channelIds?: string[]): void {
  programStore.saveSnapshot(programs, Date.now(), channelIds ?? [...new Set(programs.map(program => program.channel_id))]);
}

export function getPrograms(from?: number, to?: number): DBProgram[] {
  if (from !== undefined && to !== undefined) {
    return getProgramWindow(db, from, to);
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
  if (from !== undefined) {
    return db.prepare(
      'SELECT * FROM programs WHERE channel_id = ? AND stop_time > ? ORDER BY start_time'
    ).all(channelId, from) as DBProgram[];
  }
  return db.prepare(
    'SELECT * FROM programs WHERE channel_id = ? ORDER BY start_time'
  ).all(channelId) as DBProgram[];
}

export function getProgramByAiringKey(airingKey: string): DBProgram | undefined {
  return db.prepare('SELECT * FROM programs WHERE airing_key = ? ORDER BY last_seen DESC LIMIT 1').get(airingKey) as DBProgram | undefined;
}

export function getProgramByLegacyIdentity(channelId: string, startTime: number, stopTime: number): DBProgram | undefined {
  return db.prepare(
    'SELECT * FROM programs WHERE channel_id = ? AND start_time = ? AND stop_time = ? ORDER BY last_seen DESC LIMIT 1'
  ).get(channelId, startTime, stopTime) as DBProgram | undefined;
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
  program_start_time?: number | null;
  program_stop_time?: number | null;
  rule_revision?: number | null;
  cadence_slot?: number | null;
  created_at: number;
  airing_key?: string | null;
  content_key?: string | null;
  master_file_path?: string | null;
  derivative_file_path?: string | null;
  derivative_error?: string | null;
  analysis_state?: string;
  analysis_error?: string | null;
  analysis_requested_at?: number | null;
  analysis_started_at?: number | null;
  analysis_completed_at?: number | null;
  analysis_profile?: string | null;
  commercial_skip_override?: number | null;
  commercial_segment_count?: number;
  commercial_seconds?: number;
}

export function insertRecording(rec: DBRecording): void {
  db.prepare(`
    INSERT INTO recordings (
      id, channel_id, channel_name, title, status, start_time, end_time, actual_start, actual_end,
      file_path, file_size, duration, error, rule_id, program_title, program_start_time, program_stop_time,
      rule_revision, cadence_slot, created_at, airing_key, content_key,
      master_file_path, derivative_file_path, derivative_error, analysis_state, analysis_error,
      analysis_requested_at, analysis_started_at, analysis_completed_at, analysis_profile, commercial_skip_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id, rec.channel_id, rec.channel_name, rec.title, rec.status, rec.start_time, rec.end_time,
    rec.actual_start, rec.actual_end, rec.file_path, rec.file_size, rec.duration, rec.error, rec.rule_id,
    rec.program_title, rec.program_start_time ?? null, rec.program_stop_time ?? null, rec.rule_revision ?? null,
    rec.cadence_slot ?? null, rec.created_at, rec.airing_key ?? null, rec.content_key ?? null,
    rec.master_file_path ?? null, rec.derivative_file_path ?? null, rec.derivative_error ?? null,
    rec.analysis_state ?? 'not_requested', rec.analysis_error ?? null, rec.analysis_requested_at ?? null,
    rec.analysis_started_at ?? null, rec.analysis_completed_at ?? null, rec.analysis_profile ?? null,
    rec.commercial_skip_override ?? null,
  );
}

const insertRecordingForAiringTransaction = db.transaction((recording: DBRecording): DBRecording => {
  if (!recording.airing_key) throw new Error('Idempotent recording insert requires an airing key');
  const existing = getRecordingByAiringKey(recording.airing_key);
  if (existing) return existing;
  try {
    insertRecording(recording);
    return recording;
  } catch (error) {
    const raced = getRecordingByAiringKey(recording.airing_key);
    if (raced) return raced;
    throw error;
  }
});

export function insertRecordingForAiring(recording: DBRecording): DBRecording {
  return insertRecordingForAiringTransaction(recording);
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

export function updateRecordingIfStatus(
  id: string,
  expectedStatuses: string[],
  updates: Partial<Omit<DBRecording, 'id'>>,
): boolean {
  if (expectedStatuses.length === 0) return false;
  const fields = Object.keys(updates);
  if (fields.length === 0) return false;
  const values = Object.values(updates).map(value => value ?? null);
  const placeholders = expectedStatuses.map(() => '?').join(',');
  return db.prepare(`UPDATE recordings SET ${fields.map(field => `${field}=?`).join(',')} WHERE id=? AND status IN (${placeholders})`)
    .run(...values, id, ...expectedStatuses).changes === 1;
}

const completeRecordingTransaction = db.transaction((
  id: string,
  updates: Partial<Omit<DBRecording, 'id'>>,
  ruleId: string | null,
  ruleRevision: number | null,
  programStartTime: number | null,
  airingKey: string | null,
): boolean => {
  const completed = updateRecordingIfStatus(id, ['finalizing'], updates);
  if (completed && ruleId && ruleRevision !== null && programStartTime !== null) {
    advanceRecordingRuleCadence(ruleId, ruleRevision, programStartTime, airingKey);
  }
  return completed;
});

export function completeRecordingAndAdvanceCadence(
  id: string,
  updates: Partial<Omit<DBRecording, 'id'>>,
  ruleId: string | null,
  ruleRevision: number | null,
  programStartTime: number | null,
  airingKey: string | null,
): boolean {
  return completeRecordingTransaction(id, updates, ruleId, ruleRevision, programStartTime, airingKey);
}

export function deleteRecording(id: string): void {
  commercialStore.deleteRecordingWithSegments(id);
}

const recordingSelect = `SELECT recordings.*,
  (SELECT COUNT(*) FROM commercial_segments WHERE recording_id = recordings.id) AS commercial_segment_count,
  COALESCE((SELECT SUM(end_seconds - start_seconds) FROM commercial_segments WHERE recording_id = recordings.id), 0) AS commercial_seconds
  FROM recordings`;

export function getRecording(id: string): DBRecording | undefined {
  return db.prepare(`${recordingSelect} WHERE recordings.id = ?`).get(id) as DBRecording | undefined;
}

export function getRecordings(filter?: { status?: string; limit?: number; offset?: number }): DBRecording[] {
  let sql = recordingSelect;
  const params: unknown[] = [];
  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY start_time DESC';
  if (filter?.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  } else if (filter?.offset !== undefined) {
    sql += ' LIMIT -1';
  }
  if (filter?.offset !== undefined) {
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

export function getRecordedContentKeysByRuleId(ruleId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT content_key FROM recordings
    WHERE rule_id=? AND content_key IS NOT NULL AND status NOT IN ('cancelled', 'failed')
  `).all(ruleId) as Array<{ content_key: string }>;
  return new Set(rows.map(row => row.content_key));
}

export function getRecordingByAiringKey(airingKey: string): DBRecording | undefined {
  return db.prepare("SELECT * FROM recordings WHERE airing_key = ? AND status != 'cancelled' ORDER BY created_at LIMIT 1")
    .get(airingKey) as DBRecording | undefined;
}

export function getCommercialSegments(recordingId: string): DBCommercialSegment[] {
  return commercialStore.getSegments(recordingId);
}

export function replaceCommercialSegments(recordingId: string, segments: CommercialSegmentWrite[]): void {
  commercialStore.replaceSegments(recordingId, segments);
}

export function queueCommercialAnalysis(recordingId: string, now: number): boolean {
  return commercialStore.queueAnalysis(recordingId, now);
}

export function replaceCommercialSegmentsIfIdle(
  recordingId: string,
  segments: CommercialSegmentWrite[],
  state: 'review_needed' | 'ready',
  now: number,
): boolean {
  return commercialStore.replaceSegmentsIfIdle(recordingId, segments, state, now);
}

export function recoverStaleCommercialAnalysis(): number {
  return commercialStore.recoverStaleAnalysis();
}

export function claimNextQueuedAnalysis(now: number): DBRecording | undefined {
  return commercialStore.claimNextQueuedAnalysis(now) as unknown as DBRecording | undefined;
}

export function failCommercialAnalysis(id: string, message: string, now: number): boolean {
  return commercialStore.failAnalysis(id, message, now);
}

export function completeCommercialAnalysis(
  id: string,
  segments: CommercialSegmentWrite[],
  state: 'review_needed' | 'ready',
  profile: string,
  now: number,
): boolean {
  return commercialStore.completeAnalysis(id, segments, state, profile, now);
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
  retention_count: number;
  airing_policy: 'every' | 'once';
  repeat_policy: 'all' | 'include_unknown' | 'new_only';
  cadence_mode: 'every' | 'occurrence' | 'hours' | 'daily';
  cadence_interval: number;
  daily_start_minutes: number;
  schedule_timezone: string;
  rule_revision: number;
  cadence_last_success_start: number | null;
  cadence_last_success_key: string | null;
  cadence_occurrence_progress: number;
  cadence_cursor_start: number | null;
  cadence_cursor_key: string | null;
  cadence_retry_start: number | null;
  cadence_retry_key: string | null;
  created_at: number;
}

export function insertRecordingRule(rule: DBRecordingRule): void {
  db.prepare(`
    INSERT INTO recording_rules (
      id, channel_id, channel_name, match_title, match_type, enabled,
      padding_before, padding_after, max_recordings, retention_count, airing_policy, repeat_policy,
      cadence_mode, cadence_interval, daily_start_minutes, schedule_timezone, rule_revision,
      cadence_last_success_start, cadence_last_success_key, cadence_occurrence_progress, cadence_cursor_start, cadence_cursor_key,
      cadence_retry_start, cadence_retry_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id, rule.channel_id, rule.channel_name, rule.match_title, rule.match_type, rule.enabled,
    rule.padding_before, rule.padding_after, rule.max_recordings, rule.retention_count,
    rule.airing_policy, rule.repeat_policy, rule.cadence_mode, rule.cadence_interval,
    rule.daily_start_minutes, rule.schedule_timezone, rule.rule_revision,
    rule.cadence_last_success_start, rule.cadence_last_success_key, rule.cadence_occurrence_progress, rule.cadence_cursor_start,
    rule.cadence_cursor_key, rule.cadence_retry_start, rule.cadence_retry_key, rule.created_at,
  );
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
  db.transaction(() => {
    db.prepare(`UPDATE recording_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (updates.padding_before !== undefined || updates.padding_after !== undefined) {
      db.prepare(`
        UPDATE recordings
        SET start_time = program_start_time - (SELECT padding_before FROM recording_rules WHERE id = ?),
            end_time = program_stop_time + (SELECT padding_after FROM recording_rules WHERE id = ?)
        WHERE rule_id = ?
          AND status = 'scheduled'
          AND program_start_time IS NOT NULL
          AND program_stop_time IS NOT NULL
      `).run(id, id, id);
    }
  })();
}

export function updateRecordingRuleCadenceProjection(
  ruleId: string,
  revision: number,
  updates: Pick<DBRecordingRule, 'cadence_occurrence_progress' | 'cadence_cursor_start' | 'cadence_cursor_key'>,
): boolean {
  return db.prepare(`
    UPDATE recording_rules
    SET cadence_occurrence_progress=?, cadence_cursor_start=?, cadence_cursor_key=?
    WHERE id=? AND rule_revision=?
  `).run(
    updates.cadence_occurrence_progress,
    updates.cadence_cursor_start,
    updates.cadence_cursor_key,
    ruleId,
    revision,
  ).changes === 1;
}

export function markRecordingRuleCadenceRetry(
  ruleId: string | null,
  revision: number | null,
  programStartTime: number | null,
  airingKey: string | null,
): boolean {
  if (!ruleId || revision === null || programStartTime === null) return false;
  return db.prepare(`
    UPDATE recording_rules
    SET cadence_retry_start=?, cadence_retry_key=?
    WHERE id=? AND rule_revision=?
      AND (cadence_retry_start IS NULL OR cadence_retry_start < ?
        OR (cadence_retry_start = ? AND COALESCE(cadence_retry_key, '') < COALESCE(?, '')))
  `).run(programStartTime, airingKey, ruleId, revision, programStartTime, programStartTime, airingKey).changes === 1;
}

export function advanceRecordingRuleCadence(
  ruleId: string,
  revision: number,
  programStartTime: number,
  airingKey: string | null,
): boolean {
  const result = db.prepare(`
    UPDATE recording_rules
    SET cadence_last_success_start = @start,
        cadence_last_success_key = @key,
        cadence_occurrence_progress = 0,
        cadence_cursor_start = @start,
        cadence_cursor_key = @key,
        cadence_retry_start = CASE
          WHEN cadence_retry_start IS NULL OR cadence_retry_start < @start
            OR (cadence_retry_start = @start AND COALESCE(cadence_retry_key, '') <= COALESCE(@key, ''))
          THEN NULL ELSE cadence_retry_start END,
        cadence_retry_key = CASE
          WHEN cadence_retry_start IS NULL OR cadence_retry_start < @start
            OR (cadence_retry_start = @start AND COALESCE(cadence_retry_key, '') <= COALESCE(@key, ''))
          THEN NULL ELSE cadence_retry_key END
    WHERE id = @ruleId AND rule_revision = @revision
      AND (cadence_last_success_start IS NULL OR cadence_last_success_start < @start
        OR (cadence_last_success_start = @start
          AND COALESCE(cadence_last_success_key, '') < COALESCE(@key, '')))
  `).run({ start: programStartTime, key: airingKey, ruleId, revision });
  return result.changes === 1;
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

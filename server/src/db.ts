import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'streamvault.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

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
`);

// ---------- Config helpers ----------

export function getConfig(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setConfig(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
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
}

const insertChannel = db.prepare(
  'INSERT OR REPLACE INTO channels (id, name, url, logo, grp, region, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

const clearChannels = db.prepare('DELETE FROM channels');

const insertChannelsBatch = db.transaction((channels: DBChannel[]) => {
  clearChannels.run();
  for (const ch of channels) {
    insertChannel.run(ch.id, ch.name, ch.url, ch.logo, ch.grp, ch.region, ch.content_type);
  }
});

export function saveChannels(channels: DBChannel[]): void {
  insertChannelsBatch(channels);
}

export function getChannels(): DBChannel[] {
  return db.prepare('SELECT * FROM channels ORDER BY name').all() as DBChannel[];
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

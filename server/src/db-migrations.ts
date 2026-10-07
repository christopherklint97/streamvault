import type Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

interface ColumnSpec {
  name: string;
  definition: string;
}

const PROGRAM_COLUMNS: ColumnSpec[] = [
  { name: 'source', definition: "TEXT NOT NULL DEFAULT 'legacy'" },
  { name: 'source_channel_id', definition: "TEXT NOT NULL DEFAULT ''" },
  { name: 'provider_event_id', definition: 'TEXT' },
  { name: 'provider_epg_id', definition: 'TEXT' },
  { name: 'subtitle', definition: "TEXT NOT NULL DEFAULT ''" },
  { name: 'episode_numbers_json', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'is_repeat', definition: 'INTEGER' },
  { name: 'is_new', definition: 'INTEGER' },
  { name: 'is_live', definition: 'INTEGER' },
  { name: 'original_air_date', definition: 'TEXT' },
  { name: 'raw_metadata', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { name: 'airing_key', definition: 'TEXT' },
  { name: 'content_key', definition: 'TEXT' },
  { name: 'categories_json', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'timezone', definition: "TEXT NOT NULL DEFAULT ''" },
  { name: 'first_seen', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'last_seen', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'schedule_revision', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

const RECORDING_COLUMNS: ColumnSpec[] = [
  { name: 'airing_key', definition: 'TEXT' },
  { name: 'content_key', definition: 'TEXT' },
  { name: 'master_file_path', definition: 'TEXT' },
  { name: 'derivative_file_path', definition: 'TEXT' },
  { name: 'derivative_error', definition: 'TEXT' },
  { name: 'analysis_state', definition: "TEXT NOT NULL DEFAULT 'not_requested'" },
  { name: 'analysis_error', definition: 'TEXT' },
  { name: 'analysis_requested_at', definition: 'INTEGER' },
  { name: 'analysis_started_at', definition: 'INTEGER' },
  { name: 'analysis_completed_at', definition: 'INTEGER' },
  { name: 'analysis_profile', definition: 'TEXT' },
  { name: 'commercial_skip_override', definition: 'INTEGER' },
];

const RULE_COLUMNS: ColumnSpec[] = [
  { name: 'airing_policy', definition: "TEXT NOT NULL DEFAULT 'every'" },
  { name: 'repeat_policy', definition: "TEXT NOT NULL DEFAULT 'include_unknown'" },
];

const COMMERCIAL_COLUMNS = [
  'id', 'recording_id', 'start_seconds', 'end_seconds', 'detector', 'confidence',
  'detector_version', 'review_state', 'created_at', 'updated_at',
];

function addMissingColumns(db: SqliteDatabase, table: string, columns: ColumnSpec[]): void {
  const present = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(row => row.name));
  for (const column of columns) {
    if (!present.has(column.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
  }
}

function createCommercialSegmentsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE commercial_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL,
      detector TEXT NOT NULL,
      confidence REAL,
      detector_version TEXT NOT NULL DEFAULT '',
      review_state TEXT NOT NULL DEFAULT 'suggested',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
    )
  `);
}

function sqlValue(columns: Set<string>, preferred: string, fallback: string): string {
  return columns.has(preferred) ? `"${preferred}"` : fallback;
}

function ensureCommercialSegmentsTable(db: SqliteDatabase): void {
  const object = db.prepare("SELECT type FROM sqlite_master WHERE name='commercial_segments'").get() as { type: string } | undefined;
  if (!object) {
    createCommercialSegmentsTable(db);
    return;
  }
  if (object.type !== 'table') throw new Error('commercial_segments exists but is not a table');
  const columns = new Set((db.pragma('table_info(commercial_segments)') as Array<{ name: string }>).map(row => row.name));
  if (COMMERCIAL_COLUMNS.every(column => columns.has(column))) return;
  if (!columns.has('recording_id') || !columns.has('start_seconds') || !columns.has('end_seconds')) {
    throw new Error('commercial_segments schema cannot be migrated safely');
  }

  db.exec('ALTER TABLE commercial_segments RENAME TO commercial_segments_legacy');
  createCommercialSegmentsTable(db);
  const detector = sqlValue(columns, 'detector', sqlValue(columns, 'source', "'comskip'"));
  const reviewState = sqlValue(columns, 'review_state', sqlValue(columns, 'state', "'suggested'"));
  db.exec(`
    INSERT INTO commercial_segments
      (recording_id,start_seconds,end_seconds,detector,confidence,detector_version,review_state,created_at,updated_at)
    SELECT recording_id,start_seconds,end_seconds,
      COALESCE(${detector}, 'comskip'),
      ${sqlValue(columns, 'confidence', 'NULL')},
      COALESCE(${sqlValue(columns, 'detector_version', "''")}, ''),
      COALESCE(${reviewState}, 'suggested'),
      COALESCE(${sqlValue(columns, 'created_at', '0')}, 0),
      COALESCE(${sqlValue(columns, 'updated_at', sqlValue(columns, 'created_at', '0'))}, 0)
    FROM commercial_segments_legacy
  `);
  db.exec('DROP TABLE commercial_segments_legacy');
}

function resolveLegacyAiringDuplicates(db: SqliteDatabase): void {
  db.exec(`
    UPDATE recordings
    SET airing_key = NULL
    WHERE airing_key IS NOT NULL
      AND status <> 'cancelled'
      AND rowid NOT IN (
        SELECT MIN(rowid) FROM recordings
        WHERE airing_key IS NOT NULL AND status <> 'cancelled'
        GROUP BY airing_key
      )
  `);
}

/** Additive, idempotent migration for pre-release and existing StreamVault DBs. */
export function ensureRecordingSchema(db: SqliteDatabase): void {
  db.transaction(() => {
    addMissingColumns(db, 'programs', PROGRAM_COLUMNS);
    addMissingColumns(db, 'recordings', RECORDING_COLUMNS);
    addMissingColumns(db, 'recording_rules', RULE_COLUMNS);
    ensureCommercialSegmentsTable(db);
    resolveLegacyAiringDuplicates(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_programs_airing_key ON programs(airing_key);
      CREATE INDEX IF NOT EXISTS idx_programs_source_event ON programs(source, source_channel_id, provider_event_id);
      CREATE INDEX IF NOT EXISTS idx_recordings_airing_key ON recordings(airing_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_recordings_active_airing_key
        ON recordings(airing_key) WHERE airing_key IS NOT NULL AND status <> 'cancelled';
      CREATE INDEX IF NOT EXISTS idx_recordings_analysis_state ON recordings(analysis_state);
      CREATE INDEX IF NOT EXISTS idx_commercial_segments_recording ON commercial_segments(recording_id, start_seconds);
    `);
  })();
}

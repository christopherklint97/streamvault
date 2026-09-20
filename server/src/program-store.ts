import type Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

export interface ProgramSnapshotRow {
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
  airing_key?: string | null;
  content_key?: string | null;
  categories_json?: string;
  timezone?: string;
  first_seen?: number;
  last_seen?: number;
  schedule_revision?: number;
}

const DATA_COLUMNS = [
  'channel_id', 'title', 'description', 'start_time', 'stop_time', 'category', 'source',
  'source_channel_id', 'provider_event_id', 'provider_epg_id', 'subtitle', 'episode_numbers_json',
  'is_repeat', 'is_new', 'is_live', 'original_air_date', 'raw_metadata', 'airing_key',
  'content_key', 'categories_json', 'timezone',
] as const;

type NormalizedProgram = Record<(typeof DATA_COLUMNS)[number], string | number | null>;

function normalize(program: ProgramSnapshotRow): NormalizedProgram {
  return {
    channel_id: program.channel_id,
    title: program.title,
    description: program.description ?? '',
    start_time: program.start_time,
    stop_time: program.stop_time,
    category: program.category ?? '',
    source: program.source ?? 'legacy',
    source_channel_id: program.source_channel_id ?? program.channel_id,
    provider_event_id: program.provider_event_id ?? null,
    provider_epg_id: program.provider_epg_id ?? null,
    subtitle: program.subtitle ?? '',
    episode_numbers_json: program.episode_numbers_json ?? '[]',
    is_repeat: program.is_repeat ?? null,
    is_new: program.is_new ?? null,
    is_live: program.is_live ?? null,
    original_air_date: program.original_air_date ?? null,
    raw_metadata: program.raw_metadata ?? '{}',
    airing_key: program.airing_key ?? null,
    content_key: program.content_key ?? null,
    categories_json: program.categories_json ?? JSON.stringify(program.category ? [program.category] : []),
    timezone: program.timezone ?? '',
  };
}

export function createProgramStore(db: SqliteDatabase) {
  const selectByAiring = db.prepare('SELECT * FROM programs WHERE airing_key=? ORDER BY id LIMIT 1');
  const insert = db.prepare(`
    INSERT INTO programs (${DATA_COLUMNS.join(',')}, first_seen, last_seen, schedule_revision)
    VALUES (${DATA_COLUMNS.map(() => '?').join(',')}, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE programs SET ${DATA_COLUMNS.map(column => `${column}=?`).join(',')}, last_seen=?, schedule_revision=?
    WHERE id=?
  `);

  const save = db.transaction((programs: ProgramSnapshotRow[], now: number, requestedScope?: string[]) => {
    const scope = new Set(requestedScope ?? [
      ...(db.prepare('SELECT DISTINCT channel_id FROM programs').all() as Array<{ channel_id: string }>).map(row => row.channel_id),
      ...programs.map(program => program.channel_id),
    ]);
    const retainedIds = new Set<number>();

    for (const rawProgram of programs) {
      if (!scope.has(rawProgram.channel_id)) continue;
      const program = normalize(rawProgram);
      const values = DATA_COLUMNS.map(column => program[column]);
      const existing = program.airing_key
        ? selectByAiring.get(program.airing_key) as (NormalizedProgram & { id: number; schedule_revision: number }) | undefined
        : undefined;
      if (existing) {
        const changed = DATA_COLUMNS.some(column => existing[column] !== program[column]);
        const revision = changed ? existing.schedule_revision + 1 : existing.schedule_revision;
        update.run(...values, now, revision, existing.id);
        retainedIds.add(existing.id);
      } else {
        const result = insert.run(
          ...values,
          rawProgram.first_seen ?? now,
          rawProgram.last_seen ?? now,
          rawProgram.schedule_revision ?? 1,
        );
        retainedIds.add(Number(result.lastInsertRowid));
      }
    }

    if (scope.size === 0) return;
    const scopeJson = JSON.stringify([...scope]);
    const retainedJson = JSON.stringify([...retainedIds]);
    db.prepare(`
      DELETE FROM programs
      WHERE channel_id IN (SELECT value FROM json_each(?))
        AND id NOT IN (SELECT value FROM json_each(?))
    `).run(scopeJson, retainedJson);
  });

  return {
    saveSnapshot(programs: ProgramSnapshotRow[], now = Date.now(), channelScope?: string[]): void {
      if (programs.length === 0) return;
      save(programs, now, channelScope);
    },
  };
}

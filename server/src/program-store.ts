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

function hasUsableAiringKey(value: string | number | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

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
  const insert = db.prepare(`
    INSERT INTO programs (${DATA_COLUMNS.join(',')}, first_seen, last_seen, schedule_revision)
    VALUES (${DATA_COLUMNS.map(() => '?').join(',')}, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE programs SET ${DATA_COLUMNS.map(column => `${column}=?`).join(',')}, last_seen=?, schedule_revision=?
    WHERE id=?
  `);
  const refreshLastSeen = db.prepare(`
    UPDATE programs SET last_seen=?
    WHERE id IN (SELECT value FROM json_each(?))
  `);
  const selectByScope = db.prepare(`
    SELECT * FROM programs
    WHERE channel_id IN (SELECT value FROM json_each(?))
    ORDER BY id
  `);
  const selectByAiringKeys = db.prepare(`
    SELECT * FROM programs
    WHERE airing_key IN (SELECT value FROM json_each(?))
    ORDER BY id
  `);

  const save = db.transaction((programs: ProgramSnapshotRow[], now: number, requestedScope?: string[]) => {
    const scope = new Set(requestedScope ?? [
      ...(db.prepare('SELECT DISTINCT channel_id FROM programs').all() as Array<{ channel_id: string }>).map(row => row.channel_id),
      ...programs.map(program => program.channel_id),
    ]);
    const normalizedPrograms = programs
      .filter(program => scope.has(program.channel_id))
      .map(program => ({ raw: program, normalized: normalize(program) }));
    const existingRows = requestedScope
      ? selectByScope.all(JSON.stringify([...scope])) as Array<NormalizedProgram & { id: number; schedule_revision: number }>
      : selectByAiringKeys.all(JSON.stringify(normalizedPrograms.map(({ normalized }) => normalized.airing_key).filter(Boolean))) as Array<NormalizedProgram & { id: number; schedule_revision: number }>;
    const existingByAiring = new Map<string, NormalizedProgram & { id: number; schedule_revision: number }>();
    for (const existing of existingRows) {
      if (hasUsableAiringKey(existing.airing_key) && !existingByAiring.has(existing.airing_key)) {
        existingByAiring.set(existing.airing_key, existing);
      }
    }
    const retainedIds = new Set<number>();
    const unchangedIds: number[] = [];

    for (const { raw: rawProgram, normalized: program } of normalizedPrograms) {
      const values = DATA_COLUMNS.map(column => program[column]);
      const existing = hasUsableAiringKey(program.airing_key)
        ? existingByAiring.get(program.airing_key)
        : undefined;
      if (existing) {
        const changed = DATA_COLUMNS.some(column => existing[column] !== program[column]);
        const revision = changed ? existing.schedule_revision + 1 : existing.schedule_revision;
        if (changed) {
          update.run(...values, now, revision, existing.id);
          Object.assign(existing, program, { schedule_revision: revision });
        } else {
          unchangedIds.push(existing.id);
        }
        retainedIds.add(existing.id);
      } else {
        const result = insert.run(
          ...values,
          rawProgram.first_seen ?? now,
          rawProgram.last_seen ?? now,
          rawProgram.schedule_revision ?? 1,
        );
        const id = Number(result.lastInsertRowid);
        retainedIds.add(id);
        if (hasUsableAiringKey(program.airing_key)) {
          existingByAiring.set(program.airing_key, {
            ...program,
            id,
            schedule_revision: rawProgram.schedule_revision ?? 1,
          });
        }
      }
    }

    if (unchangedIds.length > 0) {
      refreshLastSeen.run(now, JSON.stringify(unchangedIds));
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
      if (programs.length === 0 && (!channelScope || channelScope.length === 0)) return;
      save(programs, now, channelScope);
    },
  };
}

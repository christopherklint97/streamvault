import type Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

export interface ProgramWindowRow {
  channel_id: string;
  title: string;
  description: string;
  start_time: number;
  stop_time: number;
  category: string;
}

export const PROGRAM_WINDOW_SQL = `
  SELECT channel_id, title, description, start_time, stop_time, category
  FROM programs INDEXED BY idx_programs_time
  WHERE start_time < ? AND stop_time > ?
  ORDER BY channel_id, start_time
`;

export function getProgramWindow(db: SqliteDatabase, from: number, to: number): ProgramWindowRow[] {
  return db.prepare(PROGRAM_WINDOW_SQL).all(to, from) as ProgramWindowRow[];
}

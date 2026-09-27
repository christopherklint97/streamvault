import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import type { DBProgram } from './db.js';

type Request = { id: number; channelIds: string[]; from: number; to: number };
type Reply = { id: number; rows?: DBProgram[]; error?: string; durationMs?: number };

const db = new Database(workerData.dbPath as string, { readonly: true });
const statements = new Map<number, ReturnType<typeof db.prepare>>();

parentPort?.on('message', (request: Request) => {
  const start = performance.now();
  try {
    let statement = statements.get(request.channelIds.length);
    if (!statement) {
      const placeholders = request.channelIds.map(() => '?').join(',');
      statement = db.prepare(`SELECT * FROM programs WHERE channel_id IN (${placeholders}) AND start_time < ? AND stop_time > ? ORDER BY channel_id, start_time`);
      statements.set(request.channelIds.length, statement);
    }
    const rows = statement.all([...request.channelIds, request.to, request.from]) as DBProgram[];
    parentPort?.postMessage({ id: request.id, rows, durationMs: performance.now() - start } satisfies Reply);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
  }
});

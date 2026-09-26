import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { createProgramStore, type ProgramSnapshotRow } from './program-store.js';

type Request = { id: number; programs: ProgramSnapshotRow[] };
const db = new Database(workerData.dbPath as string);
const store = createProgramStore(db);

parentPort?.on('message', (request: Request) => {
  const start = performance.now();
  try {
    store.saveSnapshot(request.programs, Date.now(), [...new Set(request.programs.map(program => program.channel_id))]);
    parentPort?.postMessage({ id: request.id, durationMs: performance.now() - start });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

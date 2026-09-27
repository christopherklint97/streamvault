import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { createCategorySnapshotWriter } from './channel-snapshot.js';
import type { DBChannel } from './db.js';

type Request = { id: number; categoryId: string; channels: DBChannel[]; generation: string };
type Reply = { id: number; error?: string; durationMs?: number };
const db = new Database(workerData.dbPath as string);
db.pragma('busy_timeout = 5000');
const snapshot = createCategorySnapshotWriter(db);
const markFetched = db.prepare('UPDATE categories SET fetched_at = ?, stream_count = ? WHERE id = ?');
const sourceMode = db.prepare("SELECT value FROM config WHERE key = 'input_mode'");
const sourceGeneration = db.prepare("SELECT value FROM config WHERE key = 'catalog_generation'");
const publish = db.transaction((categoryId: string, channels: DBChannel[], generation: string) => {
  // A queued Xtream result must never repopulate channels after manual sync.
  if ((sourceMode.get() as { value: string } | undefined)?.value !== 'xtream') {
    throw new Error('Xtream category source is no longer active');
  }
  if (((sourceGeneration.get() as { value: string } | undefined)?.value ?? '') !== generation) {
    throw new Error('Xtream catalog generation changed');
  }
  snapshot(categoryId, channels);
  markFetched.run(Date.now(), channels.length, categoryId);
});

parentPort?.on('message', (request: Request) => {
  const start = performance.now();
  try {
    publish(request.categoryId, request.channels, request.generation);
    parentPort?.postMessage({ id: request.id, durationMs: performance.now() - start } satisfies Reply);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
  }
});

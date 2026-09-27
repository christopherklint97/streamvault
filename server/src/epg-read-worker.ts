import { Worker } from 'node:worker_threads';
import type { DBProgram } from './db.js';

type Reply = { id: number; rows?: DBProgram[]; error?: string; durationMs?: number };

/** Run cold SQLite guide reads off the HTTP event loop. */
export function createEpgReadWorker(dbPath: string, warn: (message: string) => void = () => {}) {
  const worker = new Worker(new URL('./epg-read-thread.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { dbPath },
  });
  const pending = new Map<number, { resolve: (rows: DBProgram[]) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let closed = false;
  worker.on('message', (reply: Reply) => {
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error));
    else {
      if (reply.durationMs !== undefined && reply.durationMs >= 250) {
        warn(`Slow EPG batch read in worker: ${Math.round(reply.durationMs)}ms`);
      }
      task.resolve(reply.rows ?? []);
    }
  });
  const fail = (error: Error) => {
    closed = true;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => { if (!closed) fail(new Error(`EPG read worker exited (${code})`)); });
  return {
    read(channelIds: string[], from: number, to: number): Promise<DBProgram[]> {
      if (channelIds.length === 0) return Promise.resolve([]);
      if (closed) return Promise.reject(new Error('EPG read worker stopped'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, channelIds, from, to });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      fail(new Error('EPG read worker stopped'));
      await worker.terminate();
    },
  };
}

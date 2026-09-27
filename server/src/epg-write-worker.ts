import { Worker } from 'node:worker_threads';
import type { DBProgram } from './db.js';

type Reply = { id: number; error?: string; durationMs?: number };

/** Persist on-demand guide snapshots off the HTTP event loop. */
export function createEpgWriteWorker(dbPath: string, warn: (message: string) => void = () => {}) {
  const worker = new Worker(new URL('./epg-write-thread.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { dbPath },
  });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let closed = false;
  worker.on('message', (reply: Reply) => {
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error));
    else {
      if (reply.durationMs !== undefined && reply.durationMs >= 250) {
        warn(`Slow EPG snapshot write in worker: ${Math.round(reply.durationMs)}ms`);
      }
      task.resolve();
    }
  });
  const fail = (error: Error) => {
    closed = true;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => { if (!closed) fail(new Error(`EPG write worker exited (${code})`)); });
  return {
    save(programs: DBProgram[]): Promise<void> {
      if (programs.length === 0) return Promise.resolve();
      if (closed) return Promise.reject(new Error('EPG write worker stopped'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, programs });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      fail(new Error('EPG write worker stopped'));
      await worker.terminate();
    },
  };
}

import { Worker } from 'node:worker_threads';
import { processEntrypoint } from './process-entry.js';
import type { DBChannel } from './db.js';

type Reply = { id: number; error?: string; durationMs?: number };

/** Serial writer keeps snapshot transactions off the request event loop. */
export function createCategoryWriteWorker(dbPath: string, warn: (message: string) => void = () => {}) {
  const entry = processEntrypoint('category-write-thread', import.meta.url);
  const worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData: { dbPath } });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let closed = false;
  const fail = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  worker.on('message', (reply: Reply) => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(reply.error));
    else waiter.resolve();
    if (reply.durationMs && reply.durationMs > 1000) warn(`Category snapshot write took ${Math.round(reply.durationMs)}ms`);
  });
  worker.on('error', fail);
  worker.on('exit', code => fail(new Error(`Category write worker exited (${code})`)));
  return {
    save(categoryId: string, channels: readonly DBChannel[], generation: string): Promise<void> {
      if (closed) return Promise.reject(new Error('Category write worker stopped'));
      return new Promise<void>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, categoryId, channels, generation });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      fail(new Error('Category write worker stopped'));
      await worker.terminate();
    },
  };
}

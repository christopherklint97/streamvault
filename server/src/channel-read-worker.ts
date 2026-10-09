import { Worker } from 'node:worker_threads';
import { processEntrypoint } from './process-entry.js';
import type { DBChannel } from './db.js';

export interface DirectoryStatusSnapshot {
  channelCount: number;
  categoryCount: number;
  lastSyncTime: number;
  lastCrawlTime: number;
  contentTypeCounts: Record<string, number>;
  crawlConfigured: boolean;
}
export interface BrowseRequest { group?: string; type?: string; limit: number; after?: string }
export interface BrowseResult { channels: DBChannel[]; total: number }
export interface ChannelPageRequest { group?: string; limit: number; cursorSort?: number; cursorName?: string; cursorId?: string; inputMode: string }
export interface ChannelPageResult extends BrowseResult { groups: string[]; regions: string[]; contentTypeCounts: Record<string, number> }
type Reply = { id: number; rows?: DBChannel[]; status?: DirectoryStatusSnapshot; browse?: BrowseResult; page?: ChannelPageResult; error?: string; durationMs?: number };

/** Keep channel lookups off the HTTP event loop when SQLite or storage stalls. */
export function createChannelReadWorker(dbPath: string, warn: (message: string) => void = () => {}) {
  const entry = processEntrypoint('channel-read-thread', import.meta.url);
  const worker = new Worker(entry.url, {
    execArgv: entry.execArgv, workerData: { dbPath },
  });
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let closed = false;
  worker.on('message', (reply: Reply) => {
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error));
    else {
      if (reply.durationMs !== undefined && reply.durationMs >= 250) warn(`Slow channel lookup in worker: ${Math.round(reply.durationMs)}ms`);
      task.resolve(reply);
    }
  });
  const fail = (error: Error) => {
    closed = true;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => { if (!closed) fail(new Error(`Channel read worker exited (${code})`)); });
  return {
    byIds(ids: string[]): Promise<DBChannel[]> {
      if (ids.length === 0) return Promise.resolve([]);
      if (closed) return Promise.reject(new Error('Channel read worker stopped'));
      return new Promise<Reply>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op: 'byIds', ids: ids.slice(0, 200) });
      }).then(reply => reply.rows ?? []);
    },
    status(): Promise<DirectoryStatusSnapshot> {
      if (closed) return Promise.reject(new Error('Channel read worker stopped'));
      return new Promise<Reply>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op: 'status' });
      }).then(reply => {
        if (!reply.status) throw new Error('Channel read worker returned no status');
        return reply.status;
      });
    },
    browse(options: BrowseRequest): Promise<BrowseResult> {
      if (closed) return Promise.reject(new Error('Channel read worker stopped'));
      return new Promise<Reply>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op: 'browse', options });
      }).then(reply => {
        if (!reply.browse) throw new Error('Channel read worker returned no browse results');
        return reply.browse;
      });
    },
    page(options: ChannelPageRequest): Promise<ChannelPageResult> {
      if (closed) return Promise.reject(new Error('Channel read worker stopped'));
      return new Promise<Reply>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op: 'page', options });
      }).then(reply => {
        if (!reply.page) throw new Error('Channel read worker returned no channel page');
        return reply.page;
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      fail(new Error('Channel read worker stopped'));
      await worker.terminate();
    },
  };
}

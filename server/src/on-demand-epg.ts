import type { DBProgram } from './db.js';
import type { XtreamConfig } from './xtream.js';

const RETRY_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 10;
const MAX_PENDING = 100;

type Dependencies = {
  read: (ids: string[], from: number, to: number) => DBProgram[];
  fetch: (config: XtreamConfig, ids: number[], prefix: string, limit: number) => Promise<DBProgram[]>;
  save: (programs: DBProgram[]) => void;
  getConfig: () => XtreamConfig | null;
  warn: (message: string) => void;
};

/** Serve the cached guide immediately; refresh only missing live channels in the background. */
export function createOnDemandEpg({ read, fetch, save, getConfig, warn }: Dependencies) {
  const attempts = new Map<number, number>();
  const pending = new Set<number>();
  const urgent = new Set<number>();
  let running = false;

  async function drain(): Promise<void> {
    try {
      while (pending.size > 0) {
        const ids = [...urgent].filter(id => pending.has(id)).concat([...pending].filter(id => !urgent.has(id))).slice(0, BATCH_SIZE);
        try {
          const config = getConfig();
          if (config) {
            const programs = await fetch(config, ids, 'live_', 30);
            if (programs.length > 0) save(programs);
          }
        } catch (error) {
          warn(`On-demand EPG refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          for (const id of ids) {
            pending.delete(id);
            urgent.delete(id);
          }
        }
      }
    } finally {
      running = false;
      if (pending.size > 0) schedule();
    }
  }

  function schedule(): void {
    if (running) return;
    running = true;
    // Yield to the response before contacting the provider or writing SQLite.
    setImmediate(() => { void drain(); });
  }

  return {
    get(channelIds: string[], from: number, to: number): DBProgram[] {
      const programs = read(channelIds, from, to);
      const now = Date.now();
      if (to <= now || !getConfig()) return programs;
      const neededAt = Math.max(from, now);
      const current = new Set(programs
        .filter(program => program.start_time <= neededAt && program.stop_time > neededAt &&
          (program.last_seen ?? 0) >= now - CACHE_TTL_MS)
        .map(program => program.channel_id));
      for (const channelId of new Set(channelIds)) {
        const match = /^live_(\d+)$/.exec(channelId);
        if (!match || current.has(channelId)) continue;
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) continue;
        if (pending.has(id)) {
          if (channelIds.length === 1) urgent.add(id);
          continue;
        }
        if (pending.size >= MAX_PENDING + (channelIds.length === 1 ? BATCH_SIZE : 0)) break;
        if (now - (attempts.get(id) ?? 0) < RETRY_MS) continue;
        pending.add(id);
        if (channelIds.length === 1) urgent.add(id);
        attempts.set(id, now);
      }
      if (pending.size > 0) schedule();
      return programs;
    },
  };
}

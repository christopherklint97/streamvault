import type { DBProgram } from './db.js';
import type { XtreamConfig } from './xtream.js';

const RETRY_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 10;
const MAX_PENDING = 100;

type Dependencies = {
  read: (ids: string[], from: number, to: number) => DBProgram[] | Promise<DBProgram[]>;
  fetch: (config: XtreamConfig, ids: number[], prefix: string, limit: number) => Promise<DBProgram[]>;
  save: (programs: DBProgram[]) => void | Promise<void>;
  getConfig: () => XtreamConfig | null;
  warn: (message: string) => void;
};

function hasMismatchedProviderTimestamp(program: DBProgram): boolean {
  if (!program.raw_metadata) return false;
  try {
    const { start_timestamp: raw } = JSON.parse(program.raw_metadata) as { start_timestamp?: unknown };
    const seconds = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isSafeInteger(seconds) && seconds > 0 &&
      Math.abs(program.start_time - seconds * 1000) > 1000;
  } catch {
    return false;
  }
}

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
            if (programs.length > 0) await save(programs);
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
    async get(channelIds: string[], from: number, to: number): Promise<DBProgram[]> {
      const programs = await read(channelIds, from, to);
      const now = Date.now();
      if (to <= now || !getConfig()) return programs;
      const neededAt = Math.max(from, now);
      const current = new Set(programs
        .filter(program => program.start_time <= neededAt && program.stop_time > neededAt &&
          (program.last_seen ?? 0) >= now - CACHE_TTL_MS && !hasMismatchedProviderTimestamp(program))
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
      return programs.filter(program => !hasMismatchedProviderTimestamp(program));
    },
  };
}

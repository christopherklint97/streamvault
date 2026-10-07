import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { apiFetch, getBackendRequestScope, StaleBackendRequestError } from '../services/api';

export interface EpgProgram {
  title: string;
  description: string;
  start: string;
  stop: string;
}

export type EpgMap = Record<string, EpgProgram[]>;

const BATCH_SIZE = 100;

function getApiBase(): string {
  return SAME_ORIGIN ? '' : useChannelStore.getState().apiBaseUrl;
}

export async function fetchBatchEpg(channelIds: string[], from?: number, to?: number,
  options: { signal?: AbortSignal } = {}): Promise<EpgMap> {
  if (channelIds.length === 0) return {};
  const base = getApiBase();
  const scope = getBackendRequestScope();
  const ids = [...new Set(channelIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE));
  const results: EpgMap = {};
  let nextChunk = 0;
  const read = async () => {
    while (nextChunk < chunks.length) {
      if (scope.generation !== getBackendRequestScope().generation) throw new StaleBackendRequestError();
      if (options.signal?.aborted) throw new DOMException('Guide request cancelled', 'AbortError');
      const chunk = chunks[nextChunk++];
      const params = new URLSearchParams({ ids: chunk.join(',') });
      if (from !== undefined) params.set('from', String(from));
      if (to !== undefined) params.set('to', String(to));
      const data = await apiFetch<{ programs?: EpgMap }>(base, `/api/epg/batch?${params}`, { signal: options.signal, timeoutMs: 10_000 });
      if (scope.generation !== getBackendRequestScope().generation) throw new StaleBackendRequestError();
      if (options.signal?.aborted) throw new DOMException('Guide request cancelled', 'AbortError');
      Object.assign(results, data.programs || {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, read));
  return results;
}

export function getCurrentEpg(programs: EpgProgram[] | undefined): { current: EpgProgram | null; progress: number } {
  if (!programs || programs.length === 0) return { current: null, progress: 0 };
  const now = Date.now();
  for (const p of programs) {
    const start = new Date(p.start).getTime();
    const stop = new Date(p.stop).getTime();
    if (start <= now && stop > now) {
      const total = stop - start;
      const elapsed = now - start;
      return { current: p, progress: total > 0 ? elapsed / total : 0 };
    }
  }
  return { current: null, progress: 0 };
}

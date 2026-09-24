import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';

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

export async function fetchBatchEpg(channelIds: string[], from?: number, to?: number): Promise<EpgMap> {
  if (channelIds.length === 0) return {};
  const base = getApiBase();
  const chunks: string[][] = [];
  for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
    chunks.push(channelIds.slice(i, i + BATCH_SIZE));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const params = new URLSearchParams({ ids: chunk.join(',') });
      if (from !== undefined) params.set('from', String(from));
      if (to !== undefined) params.set('to', String(to));
      const resp = await fetch(`${base}/api/epg/batch?${params}`);
      if (!resp.ok) return {} as EpgMap;
      const data = await resp.json();
      return (data.programs || {}) as EpgMap;
    })
  );
  return Object.assign({}, ...results);
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

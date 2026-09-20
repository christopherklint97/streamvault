import type { DBProgram } from './db.js';

export async function refreshRuleChannelPrograms(
  channelIds: string[],
  fetchPrograms: (streamIds: number[]) => Promise<DBProgram[]>,
  savePrograms: (programs: DBProgram[]) => void,
): Promise<number> {
  const streamIds = [...new Set(channelIds.flatMap(channelId => {
    const match = /^live_(\d+)$/.exec(channelId);
    return match ? [Number(match[1])] : [];
  }))];
  if (streamIds.length === 0) return 0;
  try {
    const programs = await fetchPrograms(streamIds);
    // The snapshot writer clears only channels represented in this batch. An
    // empty/failed provider response must leave the last known guide intact.
    if (programs.length === 0) return 0;
    savePrograms(programs);
    return programs.length;
  } catch {
    return 0;
  }
}

import type { Program } from '../types';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Get the currently airing program for a channel.
 * When channelPrograms is provided, it should be the pre-filtered array for
 * that channel (from programsByChannel), and channelId filtering is skipped.
 */
export function getCurrentProgram(
  programs: Program[],
  channelId: string,
  channelPrograms?: Program[],
): Program | null {
  const now = new Date();
  const source = channelPrograms ?? programs;
  return (
    source.find(
      (p) =>
        (channelPrograms || p.channelId === channelId) &&
        p.start <= now &&
        p.stop > now
    ) || null
  );
}

/**
 * Get the next program for a channel.
 * When channelPrograms is provided, it should be the pre-filtered array for
 * that channel (from programsByChannel), and channelId filtering is skipped.
 */
export function getNextProgram(
  programs: Program[],
  channelId: string,
  channelPrograms?: Program[],
): Program | null {
  const now = new Date();
  const source = channelPrograms ?? programs;
  const upcoming = source
    .filter(
      (p) =>
        (channelPrograms || p.channelId === channelId) && p.start > now
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return upcoming[0] || null;
}

/**
 * Get programs for a specific channel on a specific day (midnight to midnight).
 */
export function getChannelPrograms(programs: Program[], channelId: string, date: Date): Program[] {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart.getTime() + TWENTY_FOUR_HOURS_MS);

  return programs.filter(
    (p) =>
      p.channelId === channelId &&
      p.start < dayEnd &&
      p.stop > dayStart
  );
}

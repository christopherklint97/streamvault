import type { Channel, WatchProgress } from '../types';
import { getItem, setItem } from '../utils/storage';

const RECENT_KEY = 'streamvault_recent_channels';
const LAST_WATCHED_KEY = 'streamvault_last_watched';
const WATCH_PROGRESS_KEY = 'streamvault_watch_progress';
const MAX_RECENT = 20;
const MAX_PROGRESS_ENTRIES = 100;
/** Percentage threshold to consider content "finished" */
const FINISHED_THRESHOLD = 0.95;
/** Minimum seconds watched before saving progress */
const MIN_POSITION_TO_SAVE = 10;

export function getRecentChannelIds(): string[] {
  return getItem<string[]>(RECENT_KEY, []);
}

export function getLastWatchedChannelId(): string | null {
  return getItem<string | null>(LAST_WATCHED_KEY, null);
}

export function trackWatch(channel: Channel): void {
  setItem(LAST_WATCHED_KEY, channel.id);

  const recent = getRecentChannelIds();
  const filtered = recent.filter((id) => id !== channel.id);
  filtered.unshift(channel.id);
  setItem(RECENT_KEY, filtered.slice(0, MAX_RECENT));
}

export function clearRecentChannels(): void {
  setItem(RECENT_KEY, []);
  setItem(LAST_WATCHED_KEY, null);
}

// --- Watch Progress Tracking ---

function getProgressMap(): Record<string, WatchProgress> {
  return getItem<Record<string, WatchProgress>>(WATCH_PROGRESS_KEY, {});
}

function saveProgressMap(map: Record<string, WatchProgress>): void {
  // Evict oldest entries if over limit
  const entries = Object.entries(map);
  if (entries.length > MAX_PROGRESS_ENTRIES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const trimmed: Record<string, WatchProgress> = {};
    for (const [key, val] of entries.slice(0, MAX_PROGRESS_ENTRIES)) {
      trimmed[key] = val;
    }
    setItem(WATCH_PROGRESS_KEY, trimmed);
  } else {
    setItem(WATCH_PROGRESS_KEY, map);
  }
}

/**
 * Save playback progress for a channel. Clears progress if content is finished.
 */
export function saveWatchProgress(
  channelId: string,
  position: number,
  duration: number,
  contentType: Channel['contentType']
): void {
  // Don't save negligible progress
  if (position < MIN_POSITION_TO_SAVE) return;

  const map = getProgressMap();

  // If finished (>95% watched), remove from continue watching
  if (duration > 0 && position / duration >= FINISHED_THRESHOLD) {
    delete map[channelId];
    saveProgressMap(map);
    return;
  }

  map[channelId] = {
    channelId,
    position,
    duration,
    updatedAt: Date.now(),
    contentType,
  };
  saveProgressMap(map);
}

/**
 * Get saved progress for a specific channel.
 */
export function getWatchProgress(channelId: string): WatchProgress | null {
  const map = getProgressMap();
  return map[channelId] || null;
}

/**
 * Get all channels with saved progress, ordered by most recently watched.
 * Only returns items for movies/series (not live TV, which is always "live").
 */
export function getContinueWatchingIds(): string[] {
  const map = getProgressMap();
  return Object.values(map)
    .filter((p) => p.contentType !== 'livetv' && p.duration > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => p.channelId);
}

/**
 * Clear watch progress for a specific channel.
 */
export function clearWatchProgress(channelId: string): void {
  const map = getProgressMap();
  delete map[channelId];
  saveProgressMap(map);
}

/**
 * Clear all watch progress.
 */
export function clearAllWatchProgress(): void {
  setItem(WATCH_PROGRESS_KEY, {});
}

/**
 * Filter channels by group name. If group is "All", return all channels.
 */
export function getChannelsByGroup(channels: Channel[], group: string): Channel[] {
  if (group === 'All') return channels;
  return channels.filter((c) => c.group === group);
}

/**
 * Return unique sorted group names from a list of channels.
 */
export function getGroups(channels: Channel[]): string[] {
  const groups = new Set<string>();
  for (const c of channels) {
    if (c.group) groups.add(c.group);
  }
  return Array.from(groups).sort();
}

/**
 * Return unique sorted region names from a list of channels.
 */
export function getRegions(channels: Channel[]): string[] {
  const regions = new Set<string>();
  for (const c of channels) {
    if (c.region) regions.add(c.region);
  }
  return Array.from(regions).sort();
}

/**
 * Multi-word search across channel name, group, and region.
 * All terms must match (AND logic). Case insensitive.
 */
export function searchChannels(channels: Channel[], query: string): Channel[] {
  if (!query.trim()) return channels;
  const terms = query.toLowerCase().trim().split(/\s+/);
  return channels.filter((c) => {
    const searchable = `${c.name} ${c.group} ${c.region}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

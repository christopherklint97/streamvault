import type { Channel } from '../types';
import { getItem, setItem } from '../utils/storage';

const RECENT_KEY = 'streamvault_recent_channels';
const LAST_WATCHED_KEY = 'streamvault_last_watched';
const MAX_RECENT = 20;

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

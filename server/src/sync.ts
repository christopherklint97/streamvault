import { gunzipSync } from 'node:zlib';
import { parseM3U, parseEPG } from './parsers.js';
import {
  saveChannels, savePrograms,
  getConfig, setConfig,
  getChannelCount, getProgramCount,
} from './db.js';

export type SyncPhase = 'idle' | 'fetching-playlist' | 'parsing-playlist' | 'fetching-epg' | 'parsing-epg' | 'done' | 'error';

interface SyncState {
  isSyncing: boolean;
  phase: SyncPhase;
  message: string;
  channelCount: number;
  programCount: number;
  lastSyncTime: number;
}

const state: SyncState = {
  isSyncing: false,
  phase: 'idle',
  message: '',
  channelCount: 0,
  programCount: 0,
  lastSyncTime: parseInt(getConfig('last_sync_time', '0'), 10),
};

let abortController: AbortController | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function getStatus(): SyncState {
  if (!state.isSyncing) {
    state.channelCount = getChannelCount();
    state.programCount = getProgramCount();
    state.lastSyncTime = parseInt(getConfig('last_sync_time', '0'), 10);
  }
  return { ...state };
}

function buildXtreamUrls(server: string, username: string, password: string) {
  let base = server.trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  return {
    playlistUrl: `${base}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u&output=mpegts`,
    epgUrl: `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  };
}

function getSourceUrls(): { playlistUrl: string; epgUrl: string } | null {
  const inputMode = getConfig('input_mode', 'manual');

  if (inputMode === 'xtream') {
    const server = getConfig('xtream_server');
    const username = getConfig('xtream_username');
    const password = getConfig('xtream_password');
    if (!server || !username || !password) return null;
    return buildXtreamUrls(server, username, password);
  }

  const playlistUrl = getConfig('playlist_url');
  if (!playlistUrl) return null;
  return { playlistUrl, epgUrl: getConfig('epg_url') };
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Detect gzip (magic bytes 1f 8b) or .gz extension
  const isGzip = (buffer[0] === 0x1f && buffer[1] === 0x8b) || url.endsWith('.gz');
  if (isGzip) {
    return gunzipSync(buffer).toString('utf-8');
  }
  return buffer.toString('utf-8');
}

export async function sync(): Promise<void> {
  if (state.isSyncing) return;

  const urls = getSourceUrls();
  if (!urls) {
    state.phase = 'error';
    state.message = 'No playlist source configured';
    return;
  }

  abortController = new AbortController();
  const { signal } = abortController;
  state.isSyncing = true;
  state.phase = 'fetching-playlist';
  state.message = 'Downloading playlist...';

  try {
    // Fetch and parse playlist
    const playlistText = await fetchText(urls.playlistUrl, signal);
    if (signal.aborted) return;

    state.phase = 'parsing-playlist';
    state.message = 'Parsing channels...';
    const channels = parseM3U(playlistText);
    if (signal.aborted) return;

    saveChannels(channels);
    state.channelCount = channels.length;
    state.message = `Parsed ${channels.length.toLocaleString()} channels`;

    // Fetch and parse EPG if URL is configured
    if (urls.epgUrl) {
      state.phase = 'fetching-epg';
      state.message = 'Downloading EPG data...';

      try {
        const epgText = await fetchText(urls.epgUrl, signal);
        if (signal.aborted) return;

        state.phase = 'parsing-epg';
        state.message = 'Parsing program guide...';
        const programs = parseEPG(epgText);
        if (signal.aborted) return;

        savePrograms(programs);
        state.programCount = programs.length;
        state.message = `Sync complete: ${channels.length.toLocaleString()} channels, ${programs.length.toLocaleString()} programs`;
      } catch (err) {
        if (signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        state.message = `Channels loaded (EPG failed: ${msg})`;
      }
    } else {
      state.message = `Sync complete: ${channels.length.toLocaleString()} channels`;
    }

    const now = Date.now();
    state.lastSyncTime = now;
    state.phase = 'done';
    setConfig('last_sync_time', String(now));
  } catch (err) {
    if (signal.aborted) {
      state.phase = 'idle';
      state.message = 'Sync cancelled';
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    state.phase = 'error';
    state.message = `Sync failed: ${msg}`;
  } finally {
    state.isSyncing = false;
    abortController = null;
    scheduleNext();
  }
}

export function cancelSync(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  state.isSyncing = false;
  state.phase = 'idle';
  state.message = 'Sync cancelled';
}

function getIntervalMs(): number | null {
  const interval = getConfig('sync_interval', '24h');
  switch (interval) {
    case '6h': return 6 * 60 * 60 * 1000;
    case '12h': return 12 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    default: return null; // 'startup' and 'manual' don't auto-schedule
  }
}

function scheduleNext(): void {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

  const intervalMs = getIntervalMs();
  if (!intervalMs) return;

  syncTimer = setTimeout(() => { sync(); }, intervalMs);
  console.log(`Next sync scheduled in ${intervalMs / 3600000}h`);
}

// Check on startup if a sync is needed
export function startupSync(): void {
  const urls = getSourceUrls();
  if (!urls) return;

  const interval = getConfig('sync_interval', '24h');
  const lastSync = parseInt(getConfig('last_sync_time', '0'), 10);
  const now = Date.now();

  if (interval === 'startup' || lastSync === 0) {
    console.log('Running startup sync...');
    sync();
    return;
  }

  const intervalMs = getIntervalMs();
  if (intervalMs && (now - lastSync) >= intervalMs) {
    console.log('Sync interval elapsed, syncing...');
    sync();
    return;
  }

  // Update counts from DB
  state.channelCount = getChannelCount();
  state.programCount = getProgramCount();
  scheduleNext();
}

import { apiFetch } from './api';
import { resolveMediaUrl } from './recordingPlayback';

export interface ArchiveChannel {
  channelId: string;
  channelName: string;
  enabled: boolean;
  retentionHours: number;
  status: string;
  error?: string | null;
  lastPublishedAt: number | null;
  availableFrom: number | null;
  availableTo: number | null;
  diskUsageBytes: number;
}

export interface ArchivePlayback {
  url: string;
  expiresAt: number;
  startTime: number;
  endTime: number;
  duration: number;
  snapshotId: string;
  startOffsetSeconds?: number;
  gaps: Array<{ startTime: number; endTime: number }>;
}

export async function getArchiveChannels(apiBaseUrl: string): Promise<ArchiveChannel[]> {
  const data = await apiFetch<{ archives: ArchiveChannel[] }>(apiBaseUrl, '/api/archives');
  return data.archives;
}

export async function setArchiveChannel(
  apiBaseUrl: string, channelId: string,
  policy: { channelName: string; enabled: boolean; retentionHours: number },
): Promise<ArchiveChannel> {
  const data = await apiFetch<{ archive: ArchiveChannel }>(apiBaseUrl,
    `/api/archives/${encodeURIComponent(channelId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
    });
  return data.archive;
}

export async function getArchivePlayback({ apiBaseUrl, channelId, startTime, endTime,
  pageOrigin = window.location.origin,
}: { apiBaseUrl: string; channelId: string; startTime: number; endTime: number; pageOrigin?: string }): Promise<ArchivePlayback> {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new Error('Select a valid archive time window');
  }
  const ticket = await apiFetch<ArchivePlayback>(apiBaseUrl,
    `/api/archive/${encodeURIComponent(channelId)}/playback-ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startTime, endTime }),
    });
  if (!ticket.url || !Number.isFinite(ticket.duration) || ticket.duration <= 0) {
    throw new Error('No seekable archive media is available for this period');
  }
  return { ...ticket, url: resolveMediaUrl(ticket.url, apiBaseUrl, pageOrigin) };
}

export async function getRecordingHlsPlayback({ apiBaseUrl, recordingId,
  pageOrigin = window.location.origin,
}: { apiBaseUrl: string; recordingId: string; pageOrigin?: string }): Promise<{ url: string; expiresAt: number; duration: number }> {
  const ticket = await apiFetch<{ url: string; expiresAt: number; duration: number }>(apiBaseUrl,
    `/api/recordings/${encodeURIComponent(recordingId)}/hls-ticket`, { method: 'POST' });
  if (!ticket.url || !Number.isFinite(ticket.duration) || ticket.duration <= 0) {
    throw new Error('No seekable recording media is available');
  }
  return { ...ticket, url: resolveMediaUrl(ticket.url, apiBaseUrl, pageOrigin) };
}

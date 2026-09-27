import { ApiError, apiFetch, hasStoredApiToken } from './api';

export type RecordingVodStatus = 'missing' | 'preparing' | 'ready';

export async function getRecordingVodStatus(apiBaseUrl: string, recordingId: string): Promise<RecordingVodStatus> {
  const response = await apiFetch<{ status: RecordingVodStatus }>(
    apiBaseUrl, `/api/recordings/${encodeURIComponent(recordingId)}/vod-status`,
  );
  return response.status;
}

interface PlaybackTicketResponse {
  url: string;
  expiresAt: number;
}

interface RecordingPlaybackRequest {
  apiBaseUrl: string;
  recordingId: string;
  directUrl: string;
  pageOrigin?: string;
}

export function resolveMediaUrl(url: string, apiBaseUrl: string, pageOrigin: string): string {
  let parsed: URL;
  try {
    const base = apiBaseUrl ? new URL(apiBaseUrl, pageOrigin) : new URL(pageOrigin);
    parsed = new URL(url, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    if (/^https?:\/\//i.test(url)) return parsed.toString();
    // Signed media routes must remain on the configured backend, never a protocol-relative third-party host.
    if (parsed.origin !== base.origin) throw new Error('cross-origin media route');
    if (!apiBaseUrl || base.origin === new URL(pageOrigin).origin) return url;
    return parsed.toString();
  } catch {
    throw new Error('Playback endpoint returned an invalid or unsupported URL');
  }
}

export async function getRecordingPlaybackUrl({
  apiBaseUrl,
  recordingId,
  directUrl,
  pageOrigin = window.location.origin,
}: RecordingPlaybackRequest): Promise<string> {
  try {
    const ticket = await apiFetch<PlaybackTicketResponse>(
      apiBaseUrl,
      `/api/recordings/${encodeURIComponent(recordingId)}/playback-ticket`,
      { method: 'POST' },
    );
    if (!ticket || typeof ticket.url !== 'string' || !ticket.url) {
      throw new Error('Playback ticket response did not include a URL');
    }
    return resolveMediaUrl(ticket.url, apiBaseUrl, pageOrigin);
  } catch (error) {
    const endpointUnavailable = error instanceof ApiError && (error.status === 404 || error.status === 501);
    if (endpointUnavailable && !hasStoredApiToken()) {
      return resolveMediaUrl(directUrl, apiBaseUrl, pageOrigin);
    }
    throw error;
  }
}

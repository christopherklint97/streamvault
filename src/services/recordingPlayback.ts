import { ApiError, apiFetch, hasStoredApiToken } from './api';

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

function resolveMediaUrl(url: string, apiBaseUrl: string, pageOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, pageOrigin);
  } catch {
    throw new Error('Playback endpoint returned an invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Playback endpoint returned an unsupported URL');
  }
  if (/^https?:\/\//i.test(url)) return parsed.toString();
  if (!apiBaseUrl) return url;

  const api = new URL(apiBaseUrl, pageOrigin);
  if (api.origin === new URL(pageOrigin).origin) return url;
  return `${apiBaseUrl.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
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

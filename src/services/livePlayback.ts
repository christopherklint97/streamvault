import { ApiError, apiFetch, hasStoredApiToken } from './api';
import { resolveMediaUrl } from './recordingPlayback';

/** Issue a short-lived media URL that native players can use without custom headers. */
export async function getAuthorizedLiveHlsUrl(
  apiBaseUrl: string, channelId: string, pageOrigin = window.location.origin,
): Promise<string | null> {
  try {
    const response = await apiFetch<{ playlistUrl: string }>(
      apiBaseUrl, `/api/live/${encodeURIComponent(channelId)}/authorize`,
    );
    if (typeof response?.playlistUrl !== 'string' || !response.playlistUrl) {
      throw new Error('Live playback ticket did not include a URL');
    }
    const expected = new URL(`${apiBaseUrl}/api/live/${encodeURIComponent(channelId)}/index.m3u8`, pageOrigin);
    const issued = new URL(response.playlistUrl, expected);
    if (!['http:', 'https:'].includes(issued.protocol) ||
        issued.origin !== expected.origin || issued.pathname !== expected.pathname ||
        response.playlistUrl.startsWith('//')) {
      throw new Error('Live playback endpoint returned an unrelated playlist');
    }
    return resolveMediaUrl(response.playlistUrl, apiBaseUrl, pageOrigin);
  } catch (error) {
    if (error instanceof ApiError && [404, 429, 501, 503].includes(error.status) && !hasStoredApiToken()) {
      return null; // Unavailable feed: retain the TS path rather than black-screening without auth.
    }
    throw error;
  }
}

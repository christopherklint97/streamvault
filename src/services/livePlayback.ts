import { ApiError, apiFetch, getBackendRequestScope, StaleBackendRequestError } from './api';
import { resolveMediaUrl } from './recordingPlayback';

const AUTHORIZATION_BUDGET_MS = 25_000;
let authorizationGeneration = 0;

export interface LiveAuthorizationOptions {
  /** The player owns this generation; false cancels retries after stop/restart. */
  isCurrent?: () => boolean;
}

/** Issue a short-lived media URL that native players can use without custom headers. */
export async function getAuthorizedLiveHlsUrl(
  apiBaseUrl: string, channelId: string, pageOrigin = window.location.origin,
  options: LiveAuthorizationOptions = {},
): Promise<string | null> {
  const generation = ++authorizationGeneration;
  const deadline = Date.now() + AUTHORIZATION_BUDGET_MS;
  const scope = getBackendRequestScope();
  const controller = new AbortController();
  const abortBackend = () => controller.abort();
  scope.signal?.addEventListener('abort', abortBackend, { once: true });
  const timeoutError = new DOMException('Live authorization timed out', 'TimeoutError');
  let unavailable = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError);
      controller.abort();
    }, AUTHORIZATION_BUDGET_MS);
  });
  const assertCurrent = () => {
    if (scope.generation !== getBackendRequestScope().generation) throw new StaleBackendRequestError();
    if (generation !== authorizationGeneration || options.isCurrent?.() === false) {
      throw new DOMException('Live authorization superseded', 'AbortError');
    }
  };
  const authorize = async (): Promise<string | null> => {
    while (true) {
      assertCurrent();
      if (expired) throw timeoutError;
      try {
        const response = await apiFetch<{ playlistUrl: string }>(
          apiBaseUrl, `/api/live/${encodeURIComponent(channelId)}/authorize`, { signal: controller.signal },
        );
        assertCurrent();
        if (expired) throw timeoutError;
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
        assertCurrent();
        if (expired) throw timeoutError;
        if (error instanceof ApiError && [429, 503].includes(error.status)) {
          unavailable = true;
          const retryAfter = error.retryAfter;
          const requestedDelay = retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
          const delay = Number.isNaN(requestedDelay) ? 1000 : Math.max(1000, requestedDelay);
          if (Date.now() + delay >= deadline) return null;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        if (error instanceof ApiError && [404, 501].includes(error.status)) {
          return null; // Feed unavailable: retain the existing TS path even for signed-in clients.
        }
        throw error;
      }
    }
  };
  try {
    return await Promise.race([authorize(), timeout]);
  } catch (error) {
    assertCurrent();
    // A deadline is not authentication evidence. Only an explicit unavailable
    // response permits the legacy fallback; initial transport failures reject.
    if (error === timeoutError && unavailable) return null;
    throw error;
  } finally {
    clearTimeout(timer!);
    scope.signal?.removeEventListener('abort', abortBackend);
    controller.abort();
  }
}

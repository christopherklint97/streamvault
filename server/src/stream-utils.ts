import { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { getChannelById, getConfig } from './db.js';
import { validateSourceHttpUrl } from './security.js';
import { logger } from './logger.js';

/** undici BodyReadable extends Readable with a dump() helper for safe discard. */
export type UndiciBody = Readable & { dump: (opts?: { limit?: number }) => Promise<void> };

/** Standard VLC-like headers to get past CDN restrictions */
export const VLC_HEADERS: Record<string, string> = {
  'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

/** Manually follow redirects while preserving headers (Node fetch strips them across origins) */
export async function fetchWithRedirects(url: string, headers: Record<string, string>, maxRedirects = 10, timeout?: number, allowUrl?: (url: string) => boolean, signal?: AbortSignal): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    if (allowUrl && !allowUrl(currentUrl)) throw new Error('Redirect target is not allowed');
    const opts: RequestInit = {
      headers,
      redirect: 'manual',
    };
    opts.signal = timeout && signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : signal ?? (timeout ? AbortSignal.timeout(timeout) : undefined);
    const resp = await fetch(currentUrl, opts);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error(`Redirect ${resp.status} with no Location header`);
      currentUrl = new URL(location, currentUrl).href;
      logger.info(`Stream redirect ${resp.status} → upstream`);
      if (currentUrl.includes('cloudflare-terms-of-service-abuse') || currentUrl.includes('cloudflare.com/abuse')) {
        throw new Error('Stream blocked by Cloudflare — provider CDN flagged for abuse');
      }
      await resp.text().catch(() => {});
      continue;
    }
    return resp;
  }
  throw new Error('Too many redirects');
}

export interface StreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: UndiciBody;
  finalUrl: string;
}

/**
 * Streaming-optimized upstream fetch using undici.request directly.
 *
 * Returns a Node Readable instead of a Web ReadableStream — avoids the
 * Readable.fromWeb() conversion overhead and gives a real Node stream that
 * pipes with full backpressure semantics. Uses the shared keepalive
 * dispatcher (installed globally by http-agent.ts).
 *
 * highWaterMark is set on the response body so chunks flow in ~1MB blocks
 * instead of the default 16KB — fewer syscalls at 4K bitrates.
 */
export async function requestStream(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 10,
  timeoutMs = 30_000,
  allowUrl?: (url: string) => boolean,
): Promise<StreamResponse> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    if (allowUrl && !allowUrl(currentUrl)) throw new Error('Redirect target is not allowed');
    const resp: Dispatcher.ResponseData = await request(currentUrl, {
      method: 'GET',
      headers,
      headersTimeout: timeoutMs,
      bodyTimeout: 0,
    });
    if (resp.statusCode >= 300 && resp.statusCode < 400) {
      const location = resp.headers['location'];
      if (!location) {
        await resp.body.dump().catch(() => {});
        throw new Error(`Redirect ${resp.statusCode} with no Location header`);
      }
      const locStr = Array.isArray(location) ? location[0] : location;
      currentUrl = new URL(locStr, currentUrl).href;
      logger.info(`Stream redirect ${resp.statusCode} → upstream`);
      // dump() reads-and-discards safely; destroy() causes undici to emit an
      // unhandled error event that can crash the process.
      await resp.body.dump().catch(() => {});
      if (currentUrl.includes('cloudflare-terms-of-service-abuse') || currentUrl.includes('cloudflare.com/abuse')) {
        throw new Error('Stream blocked by Cloudflare — provider CDN flagged for abuse');
      }
      continue;
    }
    // Bump highWaterMark for fewer syscalls on big payloads (4K = 25-50Mbps).
    // undici returns a Readable that can have its hwm tweaked post-construction
    // via the internal _readableState; this is a no-op if not present.
    const body = resp.body as UndiciBody & { _readableState?: { highWaterMark: number } };
    if (body._readableState) body._readableState.highWaterMark = 1024 * 1024;
    return {
      statusCode: resp.statusCode,
      headers: resp.headers,
      body,
      finalUrl: currentUrl,
    };
  }
  throw new Error('Too many redirects');
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
export { pickHeader };

/** Resolve the final stream URL for a channel, following all redirects */
export async function resolveStreamUrl(channelId: string, signal?: AbortSignal): Promise<string> {
  const channel = getChannelById(channelId);
  if (!channel?.url) {
    throw new Error(`Channel ${channelId} not found or has no URL`);
  }

  // Follow redirects to get the final URL
  const resp = await fetchWithRedirects(channel.url, VLC_HEADERS, 10, 30_000,
    url => validateSourceHttpUrl(url, getConfig('xtream_server')).ok, signal);
  // We got a final response — extract its URL
  const finalUrl = resp.url || channel.url;
  // Consume the body to free resources
  await resp.body?.cancel().catch(() => {});
  return finalUrl;
}

import { getChannelById } from './db.js';
import { logger } from './logger.js';

/** Standard VLC-like headers to get past CDN restrictions */
export const VLC_HEADERS: Record<string, string> = {
  'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

/** Manually follow redirects while preserving headers (Node fetch strips them across origins) */
export async function fetchWithRedirects(url: string, headers: Record<string, string>, maxRedirects = 10, timeout?: number): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const opts: RequestInit = {
      headers,
      redirect: 'manual',
    };
    if (timeout) opts.signal = AbortSignal.timeout(timeout);
    const resp = await fetch(currentUrl, opts);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error(`Redirect ${resp.status} with no Location header`);
      currentUrl = new URL(location, currentUrl).href;
      logger.info(`Stream redirect ${resp.status} → ${currentUrl.substring(0, 100)}...`);
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

/** Resolve the final stream URL for a channel, following all redirects */
export async function resolveStreamUrl(channelId: string): Promise<string> {
  const channel = getChannelById(channelId);
  if (!channel?.url) {
    throw new Error(`Channel ${channelId} not found or has no URL`);
  }

  // Follow redirects to get the final URL
  const resp = await fetchWithRedirects(channel.url, VLC_HEADERS, 10, 30_000);
  // We got a final response — extract its URL
  const finalUrl = resp.url || channel.url;
  // Consume the body to free resources
  await resp.body?.cancel().catch(() => {});
  return finalUrl;
}

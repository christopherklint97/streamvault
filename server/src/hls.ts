import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateSourceHttpUrl } from './security.js';

export function authorizeHlsProxyUrl(
  url: string, ticket: string | undefined, secret: Buffer, xtreamServer: string, allowedHosts: string[],
) {
  const entry = validateSourceHttpUrl(url, xtreamServer, allowedHosts);
  if (entry.ok || !ticket || !verifyHlsProxyTicket(url, ticket, secret)) return entry;
  // Signed URLs originate in a fetched manifest. Public CDN redirects can be
  // outside the entry allowlist, but the private-source boundary still applies.
  return validateSourceHttpUrl(url, xtreamServer);
}


const HLS_TICKET_TTL_MS = 12 * 60 * 60_000;

function hlsSignature(url: string, expiresAt: number, secret: Buffer): string {
  return createHmac('sha256', secret).update(`${expiresAt}\u001f${url}`).digest('base64url');
}

export function signHlsProxyUrl(url: string, secret: Buffer, now = Date.now()): string {
  const expiresAt = now + HLS_TICKET_TTL_MS;
  const ticket = `${expiresAt}.${hlsSignature(url, expiresAt, secret)}`;
  return `/api/proxy?url=${encodeURIComponent(url)}&ticket=${encodeURIComponent(ticket)}`;
}

export function verifyHlsProxyTicket(url: string, ticket: string, secret: Buffer, now = Date.now()): boolean {
  if (!/^\d{1,16}\.[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
  const expiresAt = Number(ticket.slice(0, ticket.indexOf('.')));
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + HLS_TICKET_TTL_MS) return false;
  const supplied = Buffer.from(ticket.slice(ticket.indexOf('.') + 1));
  const expected = Buffer.from(hlsSignature(url, expiresAt, secret));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function proxied(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

function resolveManifestUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

export function rewriteHlsManifest(body: string, playlistUrl: string, proxyUrl: (url: string) => string = proxied): string {
  return body.split(/\r?\n/).map(line => {
    if (!line) return line;

    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
        return `URI="${proxyUrl(resolveManifestUrl(uri, playlistUrl))}"`;
      });
    }

    return proxyUrl(resolveManifestUrl(line.trim(), playlistUrl));
  }).join('\n');
}

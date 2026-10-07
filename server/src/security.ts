import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

export interface ConfigResponse {
  inputMode: string;
  playlistUrl: string;
  epgUrl: string;
  xtreamServer: string;
  xtreamUsername: string;
  xtreamPassword: string;
  syncInterval: string;
  commercialAutoSkip: boolean;
}

export interface MaskedConfigResponse extends ConfigResponse {
  hasXtreamPassword: boolean;
}

export function maskConfigResponse(config: ConfigResponse): MaskedConfigResponse {
  return {
    ...config,
    xtreamPassword: '',
    hasXtreamPassword: config.xtreamPassword.length > 0,
  };
}

export function normalizeAllowedOrigins(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export function isAuthorizedRequest(authorization: string | undefined, expectedToken: string | undefined, headerToken?: string | string[]): boolean {
  if (!expectedToken) return true;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : authorization;
  const candidateHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  return bearer === expectedToken || candidateHeader === expectedToken;
}

function playbackSignature(recordingId: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`${recordingId}\u001f${expiresAt}`).digest('base64url');
}

export function createRecordingPlaybackTicket(
  recordingId: string,
  secret: string,
  now = Date.now(),
  ttlMs = 12 * 60 * 60_000,
): { ticket: string; expiresAt: number } {
  if (!secret) throw new Error('Playback tickets require an authentication secret');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60_000) throw new Error('Invalid playback ticket lifetime');
  const expiresAt = now + ttlMs;
  return { ticket: `${expiresAt}.${playbackSignature(recordingId, expiresAt, secret)}`, expiresAt };
}

export function canAccessRecordingStream(
  recordingId: string,
  authToken: string | undefined,
  ticket: string | undefined,
  now = Date.now(),
): boolean {
  if (!authToken) return true;
  if (!ticket || ticket.length > 256) return false;
  const separator = ticket.indexOf('.');
  if (separator <= 0 || ticket.indexOf('.', separator + 1) !== -1) return false;
  const expiresText = ticket.slice(0, separator);
  if (!/^\d{1,16}$/.test(expiresText)) return false;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  const supplied = Buffer.from(ticket.slice(separator + 1));
  const expected = Buffer.from(playbackSignature(recordingId, expiresAt, authToken));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.STREAMVAULT_AUTH_TOKEN;
  if (isAuthorizedRequest(req.header('authorization') || undefined, expectedToken, req.header('x-streamvault-token') || undefined)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost'
    || lower.endsWith('.localhost')
    || lower === '0.0.0.0'
    || lower === '::'
    || lower === '::1';
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a === 0
    || a >= 224;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::1'
    || lower === '::'
    || lower.startsWith('fc')
    || lower.startsWith('fd')
    || lower.startsWith('fe80:');
}

function isBlockedIpLiteral(hostname: string): boolean {
  const version = net.isIP(hostname);
  if (version === 4) return isPrivateIpv4(hostname);
  if (version === 6) return isPrivateIpv6(hostname);
  return false;
}

export function validateExternalHttpUrl(rawUrl: string, allowedHosts: string[] = []): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs are allowed' };
  }

  if (isBlockedHostname(url.hostname) || isBlockedIpLiteral(url.hostname)) {
    return { ok: false, error: 'URL host is not allowed' };
  }

  if (allowedHosts.length > 0 && !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    return { ok: false, error: 'URL host is outside the configured allowlist' };
  }

  return { ok: true, url };
}

export function allowedProxyHostsFromConfig(xtreamServer: string, extraHostsValue: string | undefined): string[] {
  const hosts = normalizeAllowedOrigins(extraHostsValue).map(value => {
    try { return new URL(value).hostname; } catch { return value; }
  });
  if (xtreamServer) {
    try { hosts.push(new URL(xtreamServer).hostname); } catch { /* ignore invalid stored config */ }
  }
  return [...new Set(hosts.filter(Boolean))];
}

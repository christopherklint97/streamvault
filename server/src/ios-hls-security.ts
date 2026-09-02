import { createHmac, timingSafeEqual } from 'node:crypto';

export class FixedWindowRateLimiter {
  private readonly clients = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly maximumClients = 4_096,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  allow(client: string, now = Date.now()): boolean {
    const existing = this.clients.get(client);
    if (!existing && this.clients.size >= 1_024) {
      for (const [key, state] of this.clients) {
        if (now - state.windowStart >= this.windowMs) this.clients.delete(key);
      }
      if (this.clients.size >= this.maximumClients) return false;
    }
    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.clients.set(client, { windowStart: now, count: 1 });
      return true;
    }
    if (existing.count >= this.maximum) return false;
    existing.count += 1;
    return true;
  }
}

export interface IosHlsTicketClaims {
  channelId: string;
  sourceUrl: string;
  contentType: 'series' | 'movies';
  startSeconds: number;
}

export function sanitizeFfmpegMessage(message: string): string {
  return message
    .replace(/url=[^\s&]+/gi, 'url=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]');
}

interface TicketPayload {
  expiresAt: number;
  nonce: string;
}

function signature(body: string, claims: IosHlsTicketClaims, secret: string): Buffer {
  return createHmac('sha256', secret)
    .update(JSON.stringify([claims.channelId, claims.sourceUrl, claims.contentType, claims.startSeconds, body]))
    .digest();
}

export function createIosHlsTicket(
  claims: IosHlsTicketClaims,
  secret: string,
  expiresAt: number,
  nonce: string,
): string {
  const body = Buffer.from(JSON.stringify({ expiresAt, nonce } satisfies TicketPayload)).toString('base64url');
  return `${body}.${signature(body, claims, secret).toString('base64url')}`;
}

export function verifyIosHlsTicket(
  ticket: string,
  claims: IosHlsTicketClaims,
  secret: string,
  now = Date.now(),
): { valid: true; nonce: string; expiresAt: number } | { valid: false } {
  const [body, encodedSignature, extra] = ticket.split('.');
  if (!body || !encodedSignature || extra) return { valid: false };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false };
  }
  if (!decoded || typeof decoded !== 'object') return { valid: false };
  const payload = decoded as Partial<TicketPayload>;
  const expiresAt = payload.expiresAt;
  const nonce = payload.nonce;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < now || typeof nonce !== 'string' || nonce.length < 8) {
    return { valid: false };
  }

  const expected = signature(body, claims, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { valid: false };
  return { valid: true, nonce, expiresAt };
}

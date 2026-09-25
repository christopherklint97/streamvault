import { Agent, setGlobalDispatcher } from 'undici';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net, { type LookupFunction } from 'node:net';
import tls from 'node:tls';
import { isBlockedIpLiteral } from './security.js';
import { logger } from './logger.js';

/** Resolve every DNS answer before a socket is opened, and use that same answer for the connection. */
export function createSafeLookup(
  resolve: (hostname: string, options: { family?: number; hints?: number }) => Promise<LookupAddress[]> =
    (hostname, options) => lookup(hostname, { ...options, all: true }),
): LookupFunction {
  return ((hostname: string, options: { family?: number; hints?: number; all?: boolean } | number,
    callback: (...args: unknown[]) => void) => {
    const opts = typeof options === 'number' ? { family: options } : options;
    resolve(hostname, opts).then(addresses => {
      if (!addresses.length || addresses.some(result => isBlockedIpLiteral(result.address))) {
        callback(new Error('Unsafe DNS address for upstream host'));
        return;
      }
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error));
  }) as LookupFunction;
}


/**
 * Shared HTTP dispatcher for all upstream stream fetches.
 *
 * Why: each upstream request previously opened a new TCP+TLS connection,
 * which is brutal for VOD seeks (every Range request = full handshake).
 * Keepalive + connection pool reuses sockets, drops cold-start by ~200-500ms.
 *
 *  - connections: per-origin pool size. 32 covers Range parallel + multiple users.
 *  - pipelining: 1 — disabled. Pipelining + HTTP/1.1 + stream bodies = head-of-line blocking.
 *  - keepAliveTimeout: how long an idle socket stays open client-side.
 *  - bodyTimeout: 0 — VOD/live streams are long, never time out the body.
 *  - headersTimeout: still bound so a dead upstream fails fast.
 */
export const streamAgent = new Agent({
  connections: 32,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 30_000,
  bodyTimeout: 0,
  connect: {
    keepAlive: true,
    keepAliveInitialDelay: 1_000,
    lookup: createSafeLookup(),
  },
});

// Use this dispatcher for any plain `fetch()` call too, so even ad-hoc fetches
// reuse the pool (Xtream sync, EPG fetches, etc.).
setGlobalDispatcher(streamAgent);

logger.info('HTTP keepalive agent installed (connections=32, keepAliveTimeout=30s)');

/**
 * Fire-and-forget DNS lookup + TCP/TLS handshake to upstream so the first
 * user play doesn't pay cold-start latency. We don't do an HTTP request —
 * many Xtream providers don't answer bare probes and just time us out.
 * Pre-resolving DNS and doing the TLS handshake covers the bulk of cold
 * connection cost; undici will still open its own pooled sockets on the
 * first real fetch, but the OS DNS cache + TLS session ticket cache make
 * those sockets come up fast.
 */
export async function prewarmUpstream(serverUrl: string): Promise<void> {
  try {
    const u = new URL(serverUrl);
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    const t0 = Date.now();
    // Resolve once so the OS cache has it for the next fetch.
    const { address } = await lookup(u.hostname);
    if (net.isIP(u.hostname) === 0 && isBlockedIpLiteral(address)) {
      logger.warn('Upstream prewarm skipped: hostname resolved to a private address');
      return;
    }
    const dnsMs = Date.now() - t0;

    const handshakeMs = await new Promise<number>((resolve) => {
      const t1 = Date.now();
      const sock: net.Socket = u.protocol === 'https:'
        ? tls.connect({ host: address, port, servername: u.hostname })
        : net.connect({ host: address, port });
      const done = () => {
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(Date.now() - t1);
      };
      const fail = () => {
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(-1);
      };
      sock.setTimeout(8_000);
      sock.on('connect', done);
      sock.on('secureConnect', done);
      sock.on('timeout', fail);
      sock.on('error', fail);
    });

    if (handshakeMs >= 0) {
      logger.info(`Upstream prewarm OK: ${u.hostname} (${address}) dns=${dnsMs}ms handshake=${handshakeMs}ms`);
    } else {
      logger.warn(`Upstream prewarm: DNS ok (${dnsMs}ms) but handshake failed for ${u.hostname}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Upstream prewarm skipped: ${msg}`);
  }
}

import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

export type BinaryStreamCause = 'upstream_end' | 'upstream_error' | 'upstream_close' |
  'client_close' | 'response_finish';
export interface BinaryStreamSummary {
  firstCause: BinaryStreamCause;
  upstreamEnded: boolean;
  responseFinished: boolean;
  bytes: number;
  elapsedMs: number;
}

/** Remove upstream media metadata before replacing a response with a local error. */
export function clearProxyMediaHeaders(res: ServerResponse): void {
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    res.removeHeader(name);
  }
}

/** A completed GET request is not a disconnected streaming response.
 * In particular, req.close can run after either upstream EOF or client abort.
 * Classify the first stream/response event, then wait for both streams to close. */
export function pipeBinaryStream(upstream: Readable, res: ServerResponse,
  onDone: (summary: BinaryStreamSummary) => void): void {
  const start = Date.now();
  let firstCause: BinaryStreamCause | undefined;
  let upstreamEnded = false;
  let upstreamClosed = false;
  let responseFinished = false;
  let responseClosed = false;
  let bytes = 0;
  let reported = false;
  const finish = () => {
    if (reported || !responseClosed || !upstreamClosed) return;
    reported = true;
    onDone({ firstCause: firstCause ?? 'response_finish', upstreamEnded, responseFinished,
      bytes, elapsedMs: Date.now() - start });
  };
  upstream.on('data', chunk => { bytes += Buffer.byteLength(chunk); });
  upstream.once('end', () => { upstreamEnded = true; firstCause ??= 'upstream_end'; });
  upstream.once('error', () => {
    firstCause ??= 'upstream_error';
    if (!res.headersSent) {
      clearProxyMediaHeaders(res);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error":"Stream unavailable"}');
    } else res.destroy();
  });
  upstream.once('close', () => {
    upstreamClosed = true;
    firstCause ??= 'upstream_close';
    finish();
  });
  res.once('finish', () => { responseFinished = true; firstCause ??= 'response_finish'; });
  res.once('close', () => {
    responseClosed = true;
    if (!res.writableFinished) firstCause ??= 'client_close';
    if (!upstream.destroyed) upstream.destroy();
    finish();
  });
  upstream.pipe(res);
}

import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { pipeBinaryStream, clearProxyMediaHeaders, type BinaryStreamSummary } from './binary-stream-lifecycle.js';

async function exercise(mode: 'eof' | 'abort' | 'reset' | 'resetBefore'): Promise<{ summary: BinaryStreamSummary; upstreamClosed: boolean; clientStatus: number; clientHeaders: http.IncomingHttpHeaders; body: string }> {
  let clientStatus = 0;
  let clientHeaders: http.IncomingHttpHeaders = {};
  let body = '';
  let upstreamClosed = false;
  let notifyUpstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { notifyUpstreamClosed = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    if (mode === 'resetBefore') res.flushHeaders();
    const timer = mode === 'resetBefore' ? null : setInterval(() => res.write(Buffer.alloc(188)), 10);
    if (mode === 'eof') setTimeout(() => res.end(), 80);
    if (mode === 'reset' || mode === 'resetBefore') setTimeout(() => res.destroy(), 80);
    res.on('close', () => { if (timer) clearInterval(timer); upstreamClosed = true; notifyUpstreamClosed(); });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let report!: (summary: BinaryStreamSummary) => void;
  const reported = new Promise<BinaryStreamSummary>(resolve => { report = resolve; });
  const proxy = http.createServer((_req, res) => {
    http.get(`http://127.0.0.1:${(upstream.address() as { port: number }).port}/`, response => {
      if (mode === 'resetBefore') {
        res.setHeader('Content-Type', 'video/mp2t; token=hidden');
        res.setHeader('Content-Length', '1000');
        res.setHeader('Content-Range', 'bytes 0-999/1000;token=hidden');
        res.setHeader('Accept-Ranges', 'token=hidden');
      }
      pipeBinaryStream(response, res, report);
    }).on('error', () => res.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const completed = new Promise<void>(resolve => {
      const client = http.get(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/`, response => {
        clientStatus = response.statusCode ?? 0;
        clientHeaders = response.headers;
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (mode === 'abort') response.destroy();
        });
        response.on('error', resolve);
        response.on('end', resolve);
        response.on('close', resolve);
      });
      client.on('error', resolve);
    });
    const summary = await Promise.race([reported, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('stream summary timeout')), 1500))]);
    await completed;
    await Promise.race([closed, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('upstream close timeout')), 1500))]);
    return { summary, upstreamClosed, clientStatus, clientHeaders, body };
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())),
      new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
}

describe('binary stream lifecycle', () => {
  it('reports upstream EOF before downstream/request close', async () => {
    const { summary, upstreamClosed } = await exercise('eof');
    expect(summary.firstCause).toBe('upstream_end');
    expect(summary.upstreamEnded).toBe(true);
    expect(summary.responseFinished).toBe(true);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(upstreamClosed).toBe(true);
  });
  it('sends a sanitized 502 if upstream resets before downstream headers', async () => {
    const { summary, clientStatus, clientHeaders, body } = await exercise('resetBefore');
    expect(summary.firstCause).toBe('upstream_error');
    expect(clientStatus).toBe(502);
    expect(clientHeaders['content-type']).toMatch(/^application\/json/);
    expect(clientHeaders['content-range']).toBeUndefined();
    expect(clientHeaders['accept-ranges']).toBeUndefined();
    expect(clientHeaders['content-length']).not.toBe('1000');
    expect(JSON.stringify(clientHeaders) + body).not.toContain('token=hidden');
    expect(body).toContain('Stream unavailable');
  });
  it('clears media headers before an unrelated HLS or processing error response', async () => {
    const proxy = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'video/mp2t; token=hidden');
      res.setHeader('Content-Range', 'bytes 0-999/1000;token=hidden');
      res.setHeader('Content-Length', '1000');
      res.setHeader('Accept-Ranges', 'token=hidden');
      clearProxyMediaHeaders(res);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"Stream unavailable"}');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/`);
      const body = await response.text();
      expect(response.status).toBe(502);
      expect(response.headers.get('content-range')).toBeNull();
      expect(response.headers.get('accept-ranges')).toBeNull();
      expect(response.headers.get('content-length')).not.toBe('1000');
      expect(JSON.stringify(Object.fromEntries(response.headers)) + body).not.toContain('token=hidden');
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
  it('classifies an upstream reset before downstream closure', async () => {
    const { summary, upstreamClosed } = await exercise('reset');
    expect(['upstream_error', 'upstream_close']).toContain(summary.firstCause);
    expect(summary.upstreamEnded).toBe(false);
    expect(summary.responseFinished).toBe(false);
    expect(upstreamClosed).toBe(true);
  });
  it('reports a client abort rather than upstream EOF and cancels upstream', async () => {
    const { summary, upstreamClosed } = await exercise('abort');
    expect(summary.firstCause).toBe('client_close');
    expect(summary.upstreamEnded).toBe(false);
    expect(summary.responseFinished).toBe(false);
    expect(upstreamClosed).toBe(true);
  });
});

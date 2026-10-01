import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { pipeBinaryStream, type BinaryStreamSummary } from './binary-stream-lifecycle.js';

async function exercise(mode: 'eof' | 'abort' | 'reset'): Promise<{ summary: BinaryStreamSummary; upstreamClosed: boolean }> {
  let upstreamClosed = false;
  let notifyUpstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { notifyUpstreamClosed = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const timer = setInterval(() => res.write(Buffer.alloc(188)), 10);
    if (mode === 'eof') setTimeout(() => res.end(), 80);
    if (mode === 'reset') setTimeout(() => res.destroy(), 80);
    res.on('close', () => { clearInterval(timer); upstreamClosed = true; notifyUpstreamClosed(); });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let report!: (summary: BinaryStreamSummary) => void;
  const reported = new Promise<BinaryStreamSummary>(resolve => { report = resolve; });
  const proxy = http.createServer((req, res) => {
    http.get(`http://127.0.0.1:${(upstream.address() as { port: number }).port}/`, response => {
      pipeBinaryStream(response, req, res, report);
    }).on('error', () => res.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const completed = new Promise<void>(resolve => {
      const client = http.get(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/`, response => {
        response.on('data', () => {
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
    return { summary, upstreamClosed };
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

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLiveUpstreamShare, type ShareableUpstream } from './live-upstream-share.js';

const packet = (marker: number) => Buffer.concat([Buffer.from([0x47, marker]), Buffer.alloc(186, marker)]);

function fakeUpstream(statusCode = 200) {
  const body = Object.assign(new PassThrough(), { dump: async () => {} });
  const upstream: ShareableUpstream = { statusCode, headers: { 'content-type': 'video/mp2t' }, body, finalUrl: 'http://provider/live' };
  return { upstream, body };
}

const collect = (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = (upstream: ShareableUpstream) => upstream.statusCode < 400;

describe('live upstream share', () => {
  it('serves every subscriber of a channel from one provider connection', async () => {
    const share = createLiveUpstreamShare();
    const { upstream, body } = fakeUpstream();
    const connect = vi.fn(async () => upstream);
    const [first, second] = await Promise.all([share.open('ch', connect, ok), share.open('ch', connect, ok)]);
    expect(connect).toHaveBeenCalledTimes(1);
    const firstData = collect(first.body), secondData = collect(second.body);
    body.write(packet(1));
    await tick();
    expect(firstData()).toEqual(packet(1));
    expect(secondData()).toEqual(packet(1));
    expect(second.statusCode).toBe(200);
    expect(share.size).toBe(1);
  });

  it('starts a late joiner on a TS packet boundary', async () => {
    const share = createLiveUpstreamShare();
    const { upstream, body } = fakeUpstream();
    const first = await share.open('ch', async () => upstream, ok);
    collect(first.body);
    body.write(Buffer.concat([packet(1), packet(2).subarray(0, 100)]));
    await tick();
    const late = await share.open('ch', vi.fn(), ok); // joins mid-packet
    const lateData = collect(late.body);
    body.write(Buffer.concat([packet(2).subarray(100), packet(3)]));
    await tick();
    expect(lateData()).toEqual(packet(3));
  });

  it('closes the provider connection when the last subscriber leaves', async () => {
    const share = createLiveUpstreamShare();
    const { upstream, body } = fakeUpstream();
    const first = await share.open('ch', async () => upstream, ok);
    const second = await share.open('ch', vi.fn(), ok);
    first.body.destroy();
    await tick();
    expect(body.destroyed).toBe(false);
    await second.body.dump();
    await tick();
    expect(body.destroyed).toBe(true);
    expect(share.size).toBe(0);
    const next = fakeUpstream();
    const reconnect = vi.fn(async () => next.upstream);
    await share.open('ch', reconnect, ok);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps separate channels on separate connections', async () => {
    const share = createLiveUpstreamShare();
    const connect = vi.fn(async () => fakeUpstream().upstream);
    await share.open('a', connect, ok);
    await share.open('b', connect, ok);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not share rejected responses', async () => {
    const share = createLiveUpstreamShare();
    const failed = fakeUpstream(503);
    const result = await share.open('ch', async () => failed.upstream, ok);
    expect(result).toBe(failed.upstream);
    expect(share.size).toBe(0);
    const next = fakeUpstream();
    const reconnect = vi.fn(async () => next.upstream);
    await share.open('ch', reconnect, ok);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('drops a stalled subscriber without holding back the others', async () => {
    const share = createLiveUpstreamShare({ maxSubscriberBufferBytes: 1_000 });
    const { upstream, body } = fakeUpstream();
    const reader = await share.open('ch', async () => upstream, ok);
    const stalled = await share.open('ch', vi.fn(), ok); // never read
    const readerData = collect(reader.body);
    for (let i = 0; i < 40; i++) body.write(packet(i));
    await tick();
    expect(stalled.body.destroyed).toBe(true);
    expect(readerData().length).toBe(40 * 188);
    expect(body.destroyed).toBe(false);
  });

  it('ends and fails subscribers with the upstream', async () => {
    const share = createLiveUpstreamShare();
    const ended = fakeUpstream();
    const sub = await share.open('a', async () => ended.upstream, ok);
    const finished = new Promise(resolve => sub.body.once('end', resolve));
    sub.body.resume();
    ended.body.end();
    await finished;
    expect(share.size).toBe(0);

    const failed = fakeUpstream();
    const other = await share.open('b', async () => failed.upstream, ok);
    const error = new Promise<Error>(resolve => other.body.once('error', resolve));
    failed.body.destroy(new Error('secret provider URL'));
    expect((await error).message).toBe('Live upstream failed');
    expect(share.size).toBe(0);
  });
});

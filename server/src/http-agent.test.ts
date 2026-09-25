import { describe, expect, it } from 'vitest';
import { Agent, request } from 'undici';
import { createServer } from 'node:http';
import { createSafeLookup } from './http-agent';

describe('safe upstream DNS', () => {
  it('rejects a hostname resolving to loopback before opening a socket', async () => {
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.end('secret'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const agent = new Agent({ connect: { lookup: createSafeLookup(async () => [{ address: '127.0.0.1', family: 4 }]) } });
    try {
      await expect(request(`http://public-name.invalid:${port}/`, { dispatcher: agent })).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      await agent.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('checks every DNS result, including later rebinding and mixed answers', async () => {
    let calls = 0;
    const lookup = createSafeLookup(async () => {
      calls++;
      return calls === 1
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '8.8.8.8', family: 4 }, { address: 'fe90::1', family: 6 }];
    });
    const resolve = () => new Promise<{ address: string }>((success, failure) => {
      lookup('example.test', { family: 0 }, ((err: Error | null, address: string) => err ? failure(err) : success({ address })) as never);
    });
    await expect(resolve()).resolves.toEqual({ address: '8.8.8.8' });
    await expect(resolve()).rejects.toThrow('Unsafe DNS');
  });
});
